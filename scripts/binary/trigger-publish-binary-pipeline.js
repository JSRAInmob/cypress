const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const fetch = require('node-fetch')
const { getNextVersionForBinary } = require('../get-next-version')

;(async () => {
  const pipelineInfoFilePath = path.join(os.homedir(), 'triggered_pipeline.json')

  const { nextVersion } = await getNextVersionForBinary()

  // This is the payload that will be sent to the cypress-publish-binary project.
  // The API is defined here: https://circleci.com/docs/api/v2/index.html#operation/triggerPipeline
  const body = JSON.stringify({
    branch: 'upgrade-electron-29',
    parameters: {
      temp_dir: os.tmpdir(),
      sha: process.env.CIRCLE_SHA1,
      job_name: process.env.CIRCLE_JOB,
      triggered_workflow_id: process.env.CIRCLE_WORKFLOW_ID,
      triggered_job_url: process.env.CIRCLE_BUILD_URL,
      should_persist_artifacts: Boolean(process.env.SHOULD_PERSIST_ARTIFACTS),
      binary_version: nextVersion,
    },
  })

  try {
    console.log('Triggering new pipeline in cypress-publish-binary project...')
    const response = await fetch('https://circleci.com/api/v2/project/github/cypress-io/cypress-publish-binary/pipeline', { method: 'POST', headers: { 'Circle-Token': process.env.CIRCLE_TOKEN, 'content-type': 'application/json' }, body })
    const pipeline = await response.json()

    console.log(pipeline)

    console.log(`Triggered pipeline: https://app.circleci.com/pipelines/github/cypress-io/cypress-publish-binary/${pipeline.number}`)

    try {
      console.log(`Saving pipeline info in ${pipelineInfoFilePath} ...`)

      await fs.writeFile(path.resolve(pipelineInfoFilePath), JSON.stringify(pipeline))
    } catch (error) {
      throw new Error(`error writing triggered pipeline info ${error}`)
    }
  } catch (error) {
    throw new Error(`error triggering new pipeline ${error}`)
  }
})()
