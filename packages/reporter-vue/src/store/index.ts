export * from './stats-store'
export * from './reporter-store'
export * from './runnables-store'
import _ from 'lodash'
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { useStatsStore } from './stats-store'


import type { Runnable, RootRunnable, Suite, Test, TestOrSuite, Hook } from '../runnables/types'

export const useStore = defineStore({
  id: 'main',
  state() {
    return {
      bus: window.reporterBus,
      runnables: {},
      runnablesTree: {},
      homelessLogs: {},
      originalValues: window.vueInitialState,
      // statsStore: useStatsStore()
    }
  },
  actions: {
    init(bus, state = {}) {
      const statsStore = useStatsStore()
      
      this.originalValues = state

      this.bus = bus
      this.bus.on('runnables:ready', (rootRunnable) => {
        this.setRunnablesFromRoot(rootRunnable)
      })
      
      this.bus.on('reporter:log:add', (props) => {
        if (props.testId) {
          if (props.hookId) {
            const hook = _.find(this.runnables[props.testId].hooks, (h => h.hookId === props.hookId))
            hook.logs.push(props)
          } else {
            this.runnables[props.testId].logs.push(props)
          }
        } else {
          // Debug only. Who ends up here?
          this.homelessLogs[props.id] = props
        }
      })

      this.bus.on('reporter:start', () => {
        statsStore.start()
      })

      this.bus.on('run:end', () => {
        statsStore.stop()
      })

      this.bus.on('reporter:restart:test:run', () => {
        this.$reset()
        statsStore.$reset()
        this.bus.emit('reporter:restarted')
      })

      this.bus.on('test:set:state', (props, cb) => {
        this.runnables[props.id] = props
        
        syncNodeWithTree(test, this.runnablesTree)
      })

      this.bus.on('test:before:run:async', (props) => {
        const test = this.runnables[props.id]
        test.state = 'running'
        syncNodeWithTree(test, this.runnablesTree)
      })

      this.bus.on('test:after:run', (props) => {
        const test = this.runnables[props.id]

        debugger
        if (props.state === 'failed') {
          test.parentRunnables.forEach((id) => {
            this.runnables[id].state = 'failed'
            syncNodeWithTree(this.runnables[id], this.runnablesTree)
          })
          
        }

        test.state = props.state
        syncNodeWithTree(test, this.runnablesTree)
      })

      this.bus.on('paused', (nextCommandName: string) => {
        // appState.pause(nextCommandName)

        // this.statsStore.pause()
      })
  
      this.bus.on('run:end', () => {
        // this.end()
        // this.statsStore.stop()
      })
    },
    setRunnablesFromRoot(rootRunnable) {
      const runnablesById = {}
      this.runnablesTree = createRunnableChildren(rootRunnable, 0, runnablesById)
      this.runnables = runnablesById
    },
    restart() {
      this.bus.emit('runner:restart')
    }
  },
  getters: {
    spec: state => state.originalValues.spec || {},
    ready: state => state.runnables !== null,
    specName: state => state.spec.name,
    tests: state => _.filter(state.runnables, r => r.type === 'test'),
    suites: state => _.filter(state.runnables, r => r.type === 'suite'),
  }
})


function createRunnables<T>(type: 'suite' | 'test', runnables: TestOrSuite<T>[], hooks: Hook[], level: number, runnablesById): (Suite | Test)[] {
  // @ts-ignore

  _.each(runnables, (runnableProps: Test | Suite, idx) => {
    runnables[idx] = createRunnable(type, runnableProps, hooks, level, runnablesById)
  })
  return runnables
}

function createRunnableChildren(props: RootRunnable, level: number, runnablesById: Record<string, Test | Suite>) {

  const addParentRunnables = (runnable) => {
    const parentRunnables = runnable.parentRunnables || []
    parentRunnables.unshift(props.id)
    return {
      ...runnable,
      parentRunnables,
      parentId: props.id
    }
  }

  props.suites = props.suites.map(addParentRunnables)
  props.tests = props.tests.map(addParentRunnables)

  return createRunnables('test', props.tests, props.hooks, level, runnablesById).concat(
    createRunnables('suite', props.suites, props.hooks, level, runnablesById),
  )
}

function createRunnable(type, props, hooks: Hook[], level: number, runnablesById) {
  runnablesById[props.id] = props
  props.hooks = _.unionBy(props.hooks, hooks, 'hookId')
  if (type === 'suite') {
    return createSuite(props as Suite, level, runnablesById)
  } else {
    return createTest(props as Test)
  }
}

function createTest(props): Test {
  const test = props
  test.hooks = [
    ...props.hooks.map(h => {
      h.logs = []
      return h
    }),
    {
      hookId: props.id.toString(),
      hookName: 'test body',
      invocationDetails: props.invocationDetails,
      logs: []
    }
  ]

  return test
}

function createSuite(props: Suite, level, runnablesById): Suite {
  return {
    ...props,
    state: null,
    children: createRunnableChildren(props, ++level, runnablesById),
  }
}


function findNodeById(curr, id) {
  if (curr.id == id) return curr
  if (curr.children && curr.children.length > 0) {
    for (let i = 0; i < curr.children.length; i++) {
      const node = findNodeById(curr.children[i], id)
      if (node) return node
    }
  }
  return null
}

function updateNodeAtId(payload, id, _tree) {
  const node = findNodeById(_tree, id)
  if (!node) return
  _.each(payload, (v, k) => {
    node[k] = v
  })
  return node
}

function syncNodeWithTree(node, _tree) {
  return updateNodeAtId(node, node.id, _tree)
}
