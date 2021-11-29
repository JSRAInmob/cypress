require('../spec_helper')

const files = require('../../lib/files')
const config = require('../../lib/config')
const FixturesHelper = require('@tooling/system-tests/lib/fixtures')
const { makeLegacyDataContext } = require('../../lib/makeDataContext')

let ctx

describe('lib/files', () => {
  beforeEach(function () {
    ctx = makeLegacyDataContext()
    FixturesHelper.scaffold()

    this.todosPath = FixturesHelper.projectPath('todos')

    ctx.actions.globalProject.setActiveProjectForTestSetup(this.todosPath)

    return config.get(this.todosPath).then((cfg) => {
      this.config = cfg;
      ({ projectRoot: this.projectRoot } = cfg)
      ctx.actions.globalProject.setActiveProjectForTestSetup(this.projectRoot)
    })
  })

  afterEach(() => {
    return FixturesHelper.remove()
  })

  context('#readFile', () => {
    it('returns contents and full file path', function () {
      return files.readFile(this.projectRoot, 'tests/_fixtures/message.txt').then(({ contents, filePath }) => {
        expect(contents).to.eq('foobarbaz')

        expect(filePath).to.include('/cy-projects/todos/tests/_fixtures/message.txt')
      })
    })

    it('returns uses utf8 by default', function () {
      return files.readFile(this.projectRoot, 'tests/_fixtures/ascii.foo').then(({ contents }) => {
        expect(contents).to.eq('\n')
      })
    })

    it('uses encoding specified in options', function () {
      return files.readFile(this.projectRoot, 'tests/_fixtures/ascii.foo', { encoding: 'ascii' }).then(({ contents }) => {
        expect(contents).to.eq('o#?\n')
      })
    })

    // https://github.com/cypress-io/cypress/issues/1558
    it('explicit null encoding is sent to driver as a Buffer', function () {
      return files.readFile(this.projectRoot, 'tests/_fixtures/ascii.foo', { encoding: null }).then(({ contents }) => {
        expect(contents).to.eql(Buffer.from('\n'))
      })
    })

    it('parses json to valid JS object', function () {
      return files.readFile(this.projectRoot, 'tests/_fixtures/users.json').then(({ contents }) => {
        expect(contents).to.eql([
          {
            id: 1,
            name: 'brian',
          }, {
            id: 2,
            name: 'jennifer',
          },
        ])
      })
    })
  })

  context('#writeFile', () => {
    it('writes the file\'s contents and returns contents and full file path', function () {
      return files.writeFile(this.projectRoot, '.projects/write_file.txt', 'foo').then(() => {
        return files.readFile(this.projectRoot, '.projects/write_file.txt').then(({ contents, filePath }) => {
          expect(contents).to.equal('foo')

          expect(filePath).to.include('/cy-projects/todos/.projects/write_file.txt')
        })
      })
    })

    it('uses encoding specified in options', function () {
      return files.writeFile(this.projectRoot, '.projects/write_file.txt', '', { encoding: 'ascii' }).then(() => {
        return files.readFile(this.projectRoot, '.projects/write_file.txt').then(({ contents }) => {
          expect(contents).to.equal('�')
        })
      })
    })

    // https://github.com/cypress-io/cypress/issues/1558
    it('explicit null encoding is written exactly as received', function () {
      return files.writeFile(this.projectRoot, '.projects/write_file.txt', Buffer.from(''), { encoding: null }).then(() => {
        return files.readFile(this.projectRoot, '.projects/write_file.txt', { encoding: null }).then(({ contents }) => {
          expect(contents).to.eql(Buffer.from(''))
        })
      })
    })

    it('overwrites existing file by default', function () {
      return files.writeFile(this.projectRoot, '.projects/write_file.txt', 'foo').then(() => {
        return files.readFile(this.projectRoot, '.projects/write_file.txt').then(({ contents }) => {
          expect(contents).to.equal('foo')

          return files.writeFile(this.projectRoot, '.projects/write_file.txt', 'bar').then(() => {
            return files.readFile(this.projectRoot, '.projects/write_file.txt').then(({ contents }) => {
              expect(contents).to.equal('bar')
            })
          })
        })
      })
    })

    it('appends content to file when specified', function () {
      return files.writeFile(this.projectRoot, '.projects/write_file.txt', 'foo').then(() => {
        return files.readFile(this.projectRoot, '.projects/write_file.txt').then(({ contents }) => {
          expect(contents).to.equal('foo')

          return files.writeFile(this.projectRoot, '.projects/write_file.txt', 'bar', { flag: 'a+' }).then(() => {
            return files.readFile(this.projectRoot, '.projects/write_file.txt').then(({ contents }) => {
              expect(contents).to.equal('foobar')
            })
          })
        })
      })
    })
  })
})
