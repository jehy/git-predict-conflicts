const program = require('commander');
const fs = require('fs-extra');
const path = require('path');
const {spawn} = require('child_process');
const Promise = require('bluebird');
const debug = require('debug');
const {lstatSync, readdirSync} = require('fs');
const {join} = require('path');

const log = {
  error: debug('predict:err'),
  info: debug('predict:info'),
};

function spawnPromise(program, args, options) {

  const display = `Running ${program} ${args.join(' ')}`;
  log.info(display);
  return new Promise((resolve, reject) => {

    let data = [];
    let err = [];
    const ps = spawn(program, args, options);
    ps.stdout.on('data', (newData) => {
      data.push(newData);
    });

    ps.stderr.on('data', (newData) => {
      err.push(newData);
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${display}: ${err.join('').substr(-200)} ${data.join('').substr(-200)}`));
        return;
      }
      resolve(data.join(''));
    });
  })
}

program
  .version('0.1.0')
  .option('-p, --path <path>', 'Git path for your repo')
  .option('-d, --diff', 'Generate diff files')
  .option('-c, --conflicts', 'Generate conflicts file')
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
      log.info(`Remote data: ${JSON.stringify(branches, null, 3)}`);
      log.info(`Fetching ${branches.length} remote branches...`);
      return Promise.map(branches, (branch) => {
        return spawnPromise('git', ['fetch', 'origin', branch], {cwd: TMPDIR});
      })
        .then(() => branches);
    })
    .then((branches) => {
      log.info(`Pulling master to remote branches...`);
      const branchesMasterConflict = [];

      return spawnPromise('git', ['reset', '--hard', 'HEAD'], {cwd: 'tmp'})
        .then(() => Promise.map(branches, (branch) => {
          return spawnPromise('git', ['checkout', branch], {cwd: 'tmp'})
            .then(() => spawnPromise('git', ['pull', '.', 'master'], {cwd: 'tmp'}))
            .catch((err) => {
              log.error(`Error: ${err}`);
              branchesMasterConflict.push(branch);
              return spawnPromise('git', ['checkout', '-f', branch], {cwd: 'tmp'});
            })
        }, {concurrency: 1})
          .then(() => [branches, branchesMasterConflict]))
    })
    .then(([branches, branchesMasterConflict]) => {
      log.info(`${branchesMasterConflict.length}/${branches.length} branches in conflict with master:`);
      log.info(`${branchesMasterConflict.join('\n')}`);
      return branches.filter((branch) => !branchesMasterConflict.includes(branch));
    })
    .then((branches) => {
      log.info(`Fetched all branches, checking diff`);
      return Promise.map(branches, (branch) => {
        const getData = spawnPromise('git', ['diff', '--name-status', `${branch}..master`], {cwd: 'tmp'});
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
            const file = `tmp/diff/${branch}.json`;
            return fs.ensureDir('tmp/diff')
              .then(() => fs.writeFile(file, JSON.stringify(fileData, null, 3)));
          })
      })
    })
    .then(() => {
      log.error('Got all diffs!');
    })
    .catch((err) => {
      throw err;
    });
}

function getFiles(source) {
  return readdirSync(source).map(name => join(source, name)).filter((file) => lstatSync(file).isFile());
}

if (program.diff) {
  fetchDiffs();
}
else if (program.conflicts) {
  const fileNames = getFiles('tmp/diff');
  const conflicts = [];
  Promise.map(fileNames, (fileName) => fs.readJson(fileName).then((data)=>[fileName, data]))
    .then((data) => {
      data.forEach((element, index) => {
        const [filename, contents] = element;
        const task = filename.replace('.json', '').replace('/tmp/diff', '');
        data.forEach((elementCompare, indexCompare) => {
          if (index === indexCompare) {
            return;
          }
          const [filenameCompare, contentsCompare] = elementCompare;
          const taskCompare = filenameCompare.replace('.json', '').replace('/tmp/diff', '');
          if (conflicts.some((conflict) => conflict.task1 === taskCompare && conflict.task2 === task)) {
            return; //avoid duplication
          }
          if (contents.changes===undefined) {
            log.error(`WTF? ${JSON.stringify(contents)}`);
            return;
          }
          if (contentsCompare.changes===undefined) {
            log.error(`WTFCOMPARE? ${JSON.stringify(contentsCompare)}`);
            return;
          }
          const onlyFiles = Object.values(contents.changes).map((obj) => obj.file);
          const onlyFilesCompare = Object.values(contentsCompare.changes).map((obj) => obj.file);
          const intersections = onlyFiles.filter((changed) => onlyFilesCompare.includes(changed));
          if (intersections.length) {
            conflicts.push({task1: task, task2: taskCompare, files: intersections});
          }
        });
      });
      return fs.writeFile('tmp/diff/conflicts.json', JSON.stringify(conflicts, null, 3));
    })
}
else {
  throw new Error('No options provided!');
}
