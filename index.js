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

function spawnPromise(program2, args, options) {

  const display = `Running ${program2} ${args.join(' ')}`;
  log.info(display);
  return new Promise((resolve, reject) => {

    const data = [];
    const err = [];
    const ps = spawn(program2, args, options);
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
  });
}

program
  .version('0.1.0')
  .option('-p, --path <path>', 'Git path for your repo')
  .option('-d, --diff', 'Generate diff files')
  .option('-c, --conflicts', 'Generate conflicts file')
  .parse(process.argv);

// console.log(JSON.stringify(program, null, 3));
const TMPDIR = 'tmp';
const TMPDATADIR = `${TMPDIR}/repo`;
const TMPGITDIR = `${TMPDATADIR}/.git`;
const checkGitPath = path.join(program.path, '.git');

function fetchDiffs() {
  return fs.remove(TMPDIR)
    .then(() => fs.ensureDir(TMPGITDIR))
    .then(() => fs.pathExists(program.path))
    .then((exists) => {
      if (!exists) {
        throw new Error(`Path ${program.path} does not exist!`);
      }
    })
    .then(() => fs.pathExists(checkGitPath))
    .then((exists) => {
      if (!exists) {
        throw new Error(`${checkGitPath} is not a git repo!`);
      }
    })
    .then(() => fs.copy(checkGitPath, TMPGITDIR))
    .then(() => {
      return spawnPromise('git', ['fetch', '--all'], {cwd: TMPGITDIR})
        .then(() => {
          const remotes = spawnPromise('git', ['ls-remote', '--heads', 'origin'], {cwd: TMPGITDIR});
          const merged = spawnPromise('git', ['branch', '--merged'], {cwd: TMPGITDIR})
            .then(data => data
              .split('\n')
              .map((item => item.trim()))
              .filter((item => !!item)));
          return Promise.all([remotes, merged]);
        });
    })
    .then(([remotes, merged]) => {
      return remotes
        .split('\n')
        .map(line => line.split('refs/heads/')[1])
        .filter(branchName => branchName && !branchName.includes('release') && !merged.includes(branchName));
      // log.info(`Remote data: ${JSON.stringify(branches, null, 3)}`);
      // log.info(`Fetching ${branches.length} remote branches...`);
      /* return Promise.map(branches, (branch) => {
        return spawnPromise('git', ['fetch', 'origin', branch], {cwd: TMPGITDIR});
      })
        .then(() => branches); */
      // .then(() => branches);
    })
    .then((branches) => {
      log.info('Pulling master to remote branches...');
      const branchesMasterConflict = [];

      return spawnPromise('git', ['reset', '--hard', 'HEAD'], {cwd: TMPDATADIR})
        .then(() => Promise.map(branches, (branch) => {
          return spawnPromise('git', ['checkout', branch], {cwd: TMPDATADIR})
            .then(() => spawnPromise('git', ['pull', '.', 'master'], {cwd: TMPDATADIR}))
            .catch((err) => {
              log.error(`Error: ${err}`);
              branchesMasterConflict.push(branch);
              return spawnPromise('git', ['checkout', '-f', branch], {cwd: TMPDATADIR});
            });
        }, {concurrency: 1})
          .then(() => [branches, branchesMasterConflict]));
    })
    .then(([branches, branchesMasterConflict]) => {
      log.info(`${branchesMasterConflict.length}/${branches.length} branches in conflict with master:`);
      log.info(`${branchesMasterConflict.join('\n')}`);
      const noConflict = branches.filter(branch => !branchesMasterConflict.includes(branch));
      return fs.writeFile(`${TMPDIR}/master_conflicts.json`, JSON.stringify(branchesMasterConflict, null, 3))
        .then(() => noConflict);
    })
    .then((branches) => {
      log.info('Fetched all branches, checking diff');
      return Promise.map(branches, (branch) => {
        const getData = spawnPromise('git', ['diff', '--name-status', `${branch}..master`], {cwd: TMPDATADIR});
        const getAuthor = spawnPromise('git', ['log', `origin/${branch}`, '-1', '--pretty=format:%an %ae'], {cwd: TMPGITDIR});
        return Promise.all([getData, getAuthor])
          .then(([res, author]) => {
            const data = res
              .split('\n')
              .filter(line => !!line.trim())
              .map((line) => {
                const data2 = line.split('\t');
                return {action: data2[0], file: data2[1]};
              });
            const fileData = {changes: data, author};
            const file = `${TMPDIR}/diff/${branch}.json`;
            return fs.ensureDir(`${TMPDIR}/diff/`)
              .then(() => fs.writeFile(file, JSON.stringify(fileData, null, 3)));
          });
      });
    })
    .then(() => {
      log.error('Got all diffs!');
    })
    .catch((err) => {
      throw err;
    });
}

function getFiles(source) {
  return readdirSync(source).map(name => join(source, name)).filter(file => lstatSync(file).isFile());
}

function genConflicts() {
  const fileNames = getFiles(`${TMPDIR}/diff/`);
  const weakConflicts = ['package.json', 'package-lock.json', 'now.eslintignore', '.eslintignore'];
  const intersections = [];
  Promise.map(fileNames, fileName => fs.readJson(fileName).then(data => [fileName, data]))
    .then((data) => {
      data.forEach((element, index) => {
        const [filename, contents] = element;
        const branch = filename.replace('.json', '').replace(`${TMPDIR}/diff/`, '');
        data.forEach((elementCompare, indexCompare) => {
          if (index === indexCompare) {
            return;
          }
          const [filenameCompare, contentsCompare] = elementCompare;
          const branchCompare = filenameCompare.replace('.json', '').replace(`${TMPDIR}/diff/`, '');
          if (intersections.some(conflict => conflict.branch1 === branchCompare && conflict.branch2 === branch)) {
            return; // avoid duplication
          }
          if (contents.changes === undefined) {
            log.error(`WTF? ${JSON.stringify(contents)}`);
            process.exit(1);
          }
          if (contentsCompare.changes === undefined) {
            log.error(`WTFCOMPARE? ${JSON.stringify(contentsCompare)}`);
            process.exit(1);
          }
          const onlyFiles = Object.values(contents.changes).map(obj => obj.file);
          const onlyFilesCompare = Object.values(contentsCompare.changes).map(obj => obj.file);
          const intersectionFiles = onlyFiles
            .filter(changed => onlyFilesCompare.includes(changed))
            .filter(changed => !weakConflicts.includes(changed));
          if (intersectionFiles.length) {
            intersections.push({
              branch1: branch,
              branch2: branchCompare,
              files: intersectionFiles,
              author1: contents.author,
              author2: contentsCompare.author,
            });
          }
        });
      });
      return fs.writeFile(`${TMPDIR}/intersections.json`, JSON.stringify(intersections, null, 3));
    })
    .then(() => {
      return Promise.reduce(intersections, (res, intersection) => {
        return spawnPromise('git', ['checkout', intersection.branch1], {cwd: TMPDATADIR})
          .then(() => {
            return spawnPromise('git', ['log', '--pretty=format:%H', '-n 1'], {cwd: TMPDATADIR})
              .then((rememberLastCommit) => {
                return spawnPromise('git', ['pull', '.', intersection.branch2], {cwd: TMPDATADIR})
                  .catch((err) => {
                    log.error(`Error: ${err}`);
                    res.push(intersection);
                    return spawnPromise('git', ['checkout', '-f', intersection.branch1], {cwd: TMPDATADIR});
                  })
                  .then(() => {
                    return spawnPromise('git', ['reset', '--hard', rememberLastCommit], {cwd: TMPDATADIR})
                      .then(() => res);
                  });
              });
          });
      }, []);
    })
    .then((conflicts) => {
      return fs.writeFile(`${TMPDIR}/conflicts.json`, JSON.stringify(conflicts, null, 3));
    })
    .catch((err) => {
      throw err;
    });
}

if (program.diff) {
  fetchDiffs();
}
else if (program.conflicts) {
  genConflicts();
}
else {
  throw new Error('No options provided!');
}
