const program = require('commander');
const fs = require('fs-extra');
const path = require('path');
const {spawn} = require('child_process');
const Promise = require('bluebird');
const debug = require('debug')('predict');

function spawnPromise(program, args, options) {

  return new Promise((resolve, reject) => {

    let data = '';
    let err = '';
    const ps = spawn(program, args, options);
    ps.stdout.on('data', (newData) => {
      data += newData;
    });

    ps.stderr.on('data', (newData) => {
      err += newData;
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        reject(err);
        return;
      }
      resolve(data);
    });
  })
}

program
  .version('0.1.0')
  .option('-p, --path <path>', 'Git path for your repo')
  .parse(process.argv);

// console.log(JSON.stringify(program, null, 3));
const TMPDIR = 'tmp/.git';
const gitPath = path.join(program.path, '.git');

function fetchDiffs() {
  return fs.remove('tmp')
    .then(() => fs.ensureDir(TMPDIR))
    .then(() => fs.pathExists(program.path))
    .then((exists) => {
      if (!exists) {
        throw new Error(`Path ${program.path} does not exist!`)
      }
    })
    .then(() => fs.pathExists(gitPath))
    .then((exists) => {
      if (!exists) {
        throw new Error(`${gitPath} is not a git repo!`)
      }
    })
    .then(() => fs.copy(gitPath, TMPDIR))
    .then(() => {
      return spawnPromise('git', ['ls-remote', '--heads', 'origin'], {cwd: TMPDIR});
    })
    .then((data) => {
      const branches = data
        .split('\n')
        .map((line) => line.split('refs/heads/')[1])
        .filter((branchName) => branchName);
      debug(`Remote data: ${JSON.stringify(branches, null, 3)}`);
      debug(`Fetching ${branches.length} remote branches...`);
      return Promise.map(branches, (branch) => {
        return spawnPromise('git', ['fetch', 'origin', branch], {cwd: TMPDIR});
      })
        .then(() => branches);
    })
    .then((branches) => {
      debug(`Fetched all branches, checking diff`);
      return Promise.map(branches, (branch) => {
        const getData = spawnPromise('git', ['diff', '--name-status', `origin/${branch}..origin/master`], {cwd: TMPDIR});
        const getAuthor = spawnPromise('git', ['log', `origin/${branch}`, '-1', '--pretty=format:%an'], {cwd: TMPDIR});
        return Promise.all([getData, getAuthor])
          .then(([res, author]) => {
            const data = res
              .split('\n')
              .filter((line) => !!line.trim())
              .map((line) => {
                const data = line.split('\t');
                return {action: data[0], file: data[1]};
              });
            const fileData = {changes: data, author};
            const dir = `tmp/diff/${branch}`;
            return fs.ensureDir(dir)
              .then(() => fs.writeFile(path.join(dir, 'diff.json'), JSON.stringify(fileData, null, 3)));
          })
      })
    })
    .then(() => {
      debug('Got all diffs!');
    });
}

fetchDiffs();
//git ls-remote --heads origin
