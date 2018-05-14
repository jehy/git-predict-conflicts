# Git predict conflicts

Predicts conflicts on active branches of your repo.

## Usage

* `node ./index.js --path /your/repo/path --diff` - make files with diff from master
* `node ./index.js --path /your/repo/path --conflicts` - make file with conflict data

## Result

* `tmp/master_conflicts.json` - list of branches in conflict with master:

```javascript
[
   "TASK-1",
   "TASK-5",
   "TASK-XXX"
]
```
* `tmp/intersections.json` - list of branches where same files were modified
```javascript
[
   {
      "branch1": "TASK-1",
      "branch2": "TASK-2",
      "files": [
         "index.js",
         "index2.js"
      ],
      "author1": "Sasha Gray",
      "author2": "Harry Potter"
   },
   {
      "branch1": "TASK-2",
      "branch2": "TASK-4",
      "files": [
         "README.MD"
      ],
      "author1": "Gandalf",
      "author2": "Lev Tolstoy"
   }
]
```
* `tmp/conflicts.json` - list of conflicting branches, same format as above

