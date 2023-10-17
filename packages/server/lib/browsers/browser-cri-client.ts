import Bluebird from 'bluebird'
import CRI from 'chrome-remote-interface'
import Debug from 'debug'
import type { Protocol } from 'devtools-protocol'
import { _connectAsync, _getDelayMsForRetry } from './protocol'
import * as errors from '../errors'
import { create, CriClient } from './cri-client'
import type { ProtocolManagerShape } from '@packages/types'

const debug = Debug('cypress:server:browsers:browser-cri-client')

interface Version {
  major: number
  minor: number
}

const isVersionGte = (a: Version, b: Version) => {
  return a.major > b.major || (a.major === b.major && a.minor >= b.minor)
}

const getMajorMinorVersion = (version: string): Version => {
  const [major, minor] = version.split('.', 2).map(Number)

  return { major, minor }
}

const ensureLiveBrowser = async (hosts: string[], port: number, browserName: string): Promise<string> => {
  // since we may be attempting to connect to multiple hosts, 'connected'
  // is set to true once one of the connections succeeds so the others
  // can be cancelled
  let connected = false

  const tryBrowserConnection = async (host: string, port: number, browserName: string): Promise<string> => {
    const connectOpts = {
      host,
      port,
      getDelayMsForRetry: (i) => {
        // if we successfully connected to a different host, cancel any remaining connection attempts
        if (connected) {
          debug('cancelling any additional retries %o', { host, port })

          return
        }

        return _getDelayMsForRetry(i, browserName)
      },
    }

    await _connectAsync(connectOpts)
    connected = true

    return host
  }

  const connections = hosts.map((host) => {
    return tryBrowserConnection(host, port, browserName)
    .catch((err) => {
      // don't throw an error if we've already connected
      if (!connected) {
        const e = errors.get('CDP_COULD_NOT_CONNECT', browserName, port, err)

        e.cause = {
          err,
          host,
          port,
        }

        throw e
      }

      return ''
    })
  })

  // go through all of the hosts and attempt to make a connection
  return Promise.any(connections)
  // this only fires if ALL of the connections fail
  // otherwise if 1 succeeds and 1+ fails it won't log anything
  .catch((aggErr: AggregateError) => {
    aggErr.errors.forEach((e) => {
      const { host, port, err } = e.cause

      debug('failed to connect to CDP %o', { host, port, err })
    })

    // throw the first error we received from the aggregate
    throw aggErr.errors[0]
  })
}

const retryWithIncreasingDelay = async <T>(retryable: () => Promise<T>, browserName: string, port: number): Promise<T> => {
  let retryIndex = 0

  const retry = async () => {
    try {
      return await retryable()
    } catch (err) {
      retryIndex++
      const delay = _getDelayMsForRetry(retryIndex, browserName)

      debug('error finding browser target, maybe retrying %o', { delay, err })

      if (typeof delay === 'undefined') {
        debug('failed to connect to CDP %o', { err })
        errors.throwErr('CDP_COULD_NOT_CONNECT', browserName, port, err)
      }

      await new Promise((resolve) => setTimeout(resolve, delay))

      return retry()
    }
  }

  return retry()
}

interface CreateBrowserCriClientOptions {
  browserName: string
  fullyManageTabs?: boolean
  hosts: string[]
  onAsynchronousError: Function
  onReconnect?: (client: CriClient) => void
  port: number
  protocolManager?: ProtocolManagerShape
}

type TargetId = string

export class BrowserCriClient {
  currentlyAttachedTarget: CriClient | undefined
  // whenever we instantiate the instance we're already connected bc
  // we receive an underlying CRI connection
  // TODO: remove "connected" in favor of closing/closed or disconnected
  connected = true
  closing = false
  closed = false
  resettingBrowserTargets = false
  gracefulShutdown?: Boolean
  extraTargetClients: Map<TargetId, CRI.Client> = new Map()
  onClose: Function | null = null

  private constructor (private browserClient: CriClient, private versionInfo: CRI.VersionResult, public host: string, public port: number, private browserName: string, private onAsynchronousError: Function, private protocolManager?: ProtocolManagerShape) { }

  /**
   * Factory method for the browser cri client. Connects to the browser and then returns a chrome remote interface wrapper around the
   * browser target
   *
   * @param browserName the display name of the browser being launched
   * @param fullyManageTabs whether or not to fully manage tabs. This is useful for firefox where some work is done with marionette and some with CDP. We don't want to handle disconnections in this class in those scenarios
   * @param hosts the hosts to which to attempt to connect
   * @param onAsynchronousError callback for any cdp fatal errors
   * @param onReconnect callback for when the browser cri client reconnects to the browser
   * @param port the port to which to connect
   * @param protocolManager the protocol manager to use with the browser cri client
   * @returns a wrapper around the chrome remote interface that is connected to the browser target
   */
  static async create (options: CreateBrowserCriClientOptions): Promise<BrowserCriClient> {
    const {
      browserName,
      fullyManageTabs,
      hosts,
      onAsynchronousError,
      onReconnect,
      port,
      protocolManager,
    } = options

    const host = await ensureLiveBrowser(hosts, port, browserName)

    return retryWithIncreasingDelay(async () => {
      const versionInfo = await CRI.Version({ host, port, useHostName: true })
      const browserClient = await create(versionInfo.webSocketDebuggerUrl, onAsynchronousError, undefined, undefined, onReconnect)

      const browserCriClient = new BrowserCriClient(browserClient, versionInfo, host!, port, browserName, onAsynchronousError, protocolManager)

      if (fullyManageTabs) {
        await this._manageTabs({ browserClient, browserCriClient, browserName, host, onAsynchronousError, port })
      }

      return browserCriClient
    }, browserName, port)
  }

  static async _manageTabs ({ browserClient, browserCriClient, browserName, host, onAsynchronousError, port }) {
    const promises = [
      browserClient.send('Target.setDiscoverTargets', { discover: true }),
      browserClient.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
    ]

    // TODO: see how this affects nested iframes
    browserClient.on('Target.attachedToTarget', async (event) => {
      await this._onAttachToTarget({ browserClient, browserCriClient, event, host, port })
    })

    // TODO: listen to 'Target.targetCrashed' or 'Inspector.targetCrashed' as well?
    browserClient.on('Target.targetDestroyed', (event) => {
      this._onTargetDestroyed({ browserClient, browserCriClient, browserName, event, onAsynchronousError })
    })

    await Promise.all(promises)
  }

  static async _onAttachToTarget ({ browserClient, browserCriClient, event, host, port }) {
    const { sessionId, targetInfo, waitingForDebugger } = event
    let { targetId, url } = targetInfo

    debug('Attached to target, id: %s', targetId)

    async function run () {
      await browserClient.send('Runtime.runIfWaitingForDebugger', undefined, sessionId)
    }

    // the url usually isn't specified with this event, but is available
    // from Target.getTargets
    if (!url) {
      const { targetInfos } = await browserClient.send('Target.getTargets')

      const thisTarget = targetInfos.find((target) => target.targetId === targetId)

      if (thisTarget) {
        url = thisTarget.url
      }
    }

    if (
      // is the main Cypress tab
      targetId === browserCriClient.currentlyAttachedTarget?.targetId
      // is DevTools
      || url.includes('devtools://')
      // is the Launchpad
      || url.includes('__launchpad')
      // targets created before we started listening won't be waiting
      // for debugger and are not extras
      || !waitingForDebugger
    ) {
      debug('Not an extra target (id: %s)', targetId)

      // in these cases, we don't want to track the targets as extras.
      // we're only interested in extra tabs or windows
      return await run()
    }

    let extraTargetCriClient

    try {
      extraTargetCriClient = await CRI({
        host,
        port,
        target: targetId,
        local: true,
        useHostName: true,
      })
    } catch (err: any) {
      debug('Errored connecting to target (id: %s): %s', targetId, err?.stack || err)

      return run()
    }

    browserCriClient.addExtraTargetClient(targetId, extraTargetCriClient)

    await extraTargetCriClient.send('Fetch.enable')

    extraTargetCriClient.on('Fetch.requestPaused', async (params: Protocol.Fetch.RequestPausedEvent) => {
      const details: Protocol.Fetch.ContinueRequestRequest = {
        requestId: params.requestId,
        headers: [{ name: 'X-Cypress-Is-From-Extra-Target', value: 'true' }],
      }

      extraTargetCriClient.send('Fetch.continueRequest', details).catch((err) => {
        // swallow this error so it doesn't crash Cypress
        debug('continueRequest failed, url: %s, error: %s', params.request.url, err?.stack || err)
      })
    })

    await run()
  }

  static async _onTargetDestroyed ({ browserClient, browserCriClient, browserName, event, onAsynchronousError }) {
    debug('Target.targetDestroyed %o', {
      event,
      closing: browserCriClient.closing,
      closed: browserCriClient.closed,
      resettingBrowserTargets: browserCriClient.resettingBrowserTargets,
    })

    const { targetId } = event

    // we may have gotten a delayed "Target.targetDestroyed" even for a page that we
    // have already closed/disposed, so unless this matches our current target then bail
    if (targetId !== browserCriClient.currentlyAttachedTarget?.targetId) {
      if (browserCriClient.hasExtraTargetClient(targetId)) {
        debug('Close extra target client (id: %s)')
        browserCriClient.getExtraTargetClient(targetId)!.close().catch(() => { })
        browserCriClient.removeExtraTargetClient(targetId)
      }

      return
    }

    // otherwise...
    // the page or browser closed in an unexpected manner and we need to bubble up this error
    // by calling onError() with either browser or page was closed
    //
    // we detect this by waiting up to 500ms for either the browser's websocket connection to be closed
    // OR from process.exit(...) firing
    // if the browser's websocket connection has been closed then that means the page was closed
    //
    // otherwise it means the the browser itself was closed

    // always close the connection to the page target because it was destroyed
    browserCriClient.currentlyAttachedTarget.close().catch(() => { })

    new Bluebird((resolve) => {
      // this event could fire either expectedly or unexpectedly
      // it's not a problem if we're expected to be closing the browser naturally
      // and not as a result of an unexpected page or browser closure
      if (browserCriClient.resettingBrowserTargets) {
        // do nothing, we're good
        return resolve(true)
      }

      if (typeof browserCriClient.gracefulShutdown !== 'undefined') {
        return resolve(browserCriClient.gracefulShutdown)
      }

      // when process.on('exit') is called, we call onClose
      browserCriClient.onClose = resolve

      // or when the browser's CDP ws connection is closed
      browserClient.ws.once('close', () => {
        resolve(false)
      })
    })
    .timeout(500)
    .then((expectedDestroyedEvent) => {
      if (expectedDestroyedEvent === true) {
        return
      }

      // browserClient websocket was disconnected
      // or we've been closed due to process.on('exit')
      // meaning the browser was closed and not just the page
      errors.throwErr('BROWSER_PROCESS_CLOSED_UNEXPECTEDLY', browserName)
    })
    .catch(Bluebird.TimeoutError, () => {
      debug('browser websocket did not close, page was closed %o', { targetId: event.targetId })
      // the browser websocket didn't close meaning
      // only the page was closed, not the browser
      errors.throwErr('BROWSER_PAGE_CLOSED_UNEXPECTEDLY', browserName)
    })
    .catch((err) => {
      // stop the run instead of moving to the next spec
      err.isFatalApiErr = true

      onAsynchronousError(err)
    })
  }

  /**
   * Ensures that the minimum protocol version for the browser is met
   *
   * @param protocolVersion the minimum version to ensure
   */
  ensureMinimumProtocolVersion = (protocolVersion: string): void => {
    const actualVersion = getMajorMinorVersion(this.versionInfo['Protocol-Version'])
    const minimum = getMajorMinorVersion(protocolVersion)

    if (!isVersionGte(actualVersion, minimum)) {
      errors.throwErr('CDP_VERSION_TOO_OLD', protocolVersion, actualVersion)
    }
  }

  /**
   * Attaches to a target with the given url
   *
   * @param url the url to attach to
   * @returns the chrome remote interface wrapper for the target
   */
  attachToTargetUrl = async (url: string): Promise<CriClient> => {
    // Continue trying to re-attach until successful.
    // If the browser opens slowly, this will fail until
    // The browser and automation API is ready, so we try a few
    // times until eventually timing out.
    return retryWithIncreasingDelay(async () => {
      debug('Attaching to target url %s', url)
      const { targetInfos: targets } = await this.browserClient.send('Target.getTargets')

      const target = targets.find((target) => target.url === url)

      if (!target) {
        throw new Error(`Could not find url target in browser ${url}. Targets were ${JSON.stringify(targets)}`)
      }

      this.currentlyAttachedTarget = await create(target.targetId, this.onAsynchronousError, this.host, this.port)
      await this.protocolManager?.connectToBrowser(this.currentlyAttachedTarget)

      return this.currentlyAttachedTarget
    }, this.browserName, this.port)
  }

  /**
   * Resets the browser's targets optionally keeping a tab open
   *
   * @param shouldKeepTabOpen whether or not to keep the tab open
   */
  resetBrowserTargets = async (shouldKeepTabOpen: boolean): Promise<void> => {
    if (this.closed) {
      debug('browser cri client is closed, not resetting browser targets')

      return
    }

    this.resettingBrowserTargets = true

    if (!this.currentlyAttachedTarget) {
      throw new Error('Cannot close target because no target is currently attached')
    }

    let target

    // If we are keeping a tab open, we need to first launch a new default tab prior to closing the existing one
    if (shouldKeepTabOpen) {
      target = await this.browserClient.send('Target.createTarget', { url: 'about:blank' })
    }

    debug('currently attached targets', this.currentlyAttachedTarget.targetId, this.currentlyAttachedTarget.closed)

    if (!this.currentlyAttachedTarget.closed) {
      debug('closing current target %s', this.currentlyAttachedTarget.targetId)

      await this.browserClient.send('Target.closeTarget', { targetId: this.currentlyAttachedTarget.targetId })

      debug('target closed', this.currentlyAttachedTarget.targetId)

      await this.currentlyAttachedTarget.close().catch(() => {})

      debug('target client closed', this.currentlyAttachedTarget.targetId)
    }

    if (target) {
      this.currentlyAttachedTarget = await create(target.targetId, this.onAsynchronousError, this.host, this.port)
    } else {
      this.currentlyAttachedTarget = undefined
    }

    this.resettingBrowserTargets = false
  }

  addExtraTargetClient (targetId: TargetId, client: CRI.Client) {
    this.extraTargetClients.set(targetId, client)
  }

  hasExtraTargetClient (targetId: TargetId) {
    return this.extraTargetClients.has(targetId)
  }

  getExtraTargetClient (targetId: TargetId) {
    return this.extraTargetClients.get(targetId)
  }

  removeExtraTargetClient (targetId: TargetId) {
    this.extraTargetClients.delete(targetId)
  }

  async closeExtraTargets () {
    for (const [targetId] of this.extraTargetClients) {
      debug('Close extra target (id: %s)', targetId)
      await this.browserClient.send('Target.closeTarget', { targetId })
    }
  }

  /**
   * @returns the websocket debugger URL for the currently connected browser
   */
  getWebSocketDebuggerUrl () {
    return this.versionInfo.webSocketDebuggerUrl
  }

  /**
   * Closes the browser client socket as well as the socket for the currently attached page target
   */
  close = async (gracefulShutdown) => {
    this.gracefulShutdown = gracefulShutdown

    this.onClose && this.onClose(gracefulShutdown)

    if (this.connected === false) {
      debug('browser cri client is already closed')

      return
    }

    this.closing = true
    this.connected = false

    if (this.currentlyAttachedTarget) {
      await this.currentlyAttachedTarget.close()
    }

    await this.browserClient.close()

    this.closed = true
  }
}
