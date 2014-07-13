var fs = require('fs'),
    path = require('path'),
    wildmatch = require('wildmatch'),
    microee = require('microee');

// Totally based on the node-glob approach, though not using the exact same code.
//
// PROCESS(pattern)
// Get the first [n] items from pattern that are all strings
// Join these together.  This is PREFIX.
//   If there is no more remaining, then stat(PREFIX) and
//   add to matches if it succeeds.  END.
// readdir(PREFIX) as ENTRIES
//   If fails, END
//   If pattern[n] is GLOBSTAR
//     // handle the case where the globstar match is empty
//     // by pruning it out, and testing the resulting pattern
//     PROCESS(pattern[0..n] + pattern[n+1 .. $])
//     // handle other cases.
//     for ENTRY in ENTRIES (not dotfiles)
//       // attach globstar + tail onto the entry
//       PROCESS(pattern[0..n] + ENTRY + pattern[n .. $])
//
//   else // not globstar
//     for ENTRY in ENTRIES (not dotfiles, unless pattern[n] is dot)
//       Test ENTRY against pattern[n]
//       If fails, continue
//       If passes, PROCESS(pattern[0..n] + item + pattern[n+1 .. $])
//

module.exports = glob;

function glob(pattern, opts, onDone) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (!opts) {
    opts = {};
  }
  var g = new Glob(pattern, opts, onDone);
  return g.sync ? g.found : g;
}

function Glob(pattern, opts, onDone) {
  var self = this;
  this.sync = true;
  this.nomount = false;
  this.cwd = opts.cwd || process.cwd();
  this.root = path.resolve(this.cwd, '/');
  this.root = path.resolve(this.root);
  if (process.platform === "win32") {
    this.root = this.root.replace(/\\/g, '/');
  }

  // set up the wildmatch filter, which simply checks the emitted files against
  // the pattern
  this.found = [];
  this.pattern = pattern;
  this._process(pattern);
}

microee.mixin(Glob);

Glob.prototype._filter = function(filepath) {
  var isMatch = wildmatch(filepath, this.pattern);
  console.log('_filter', filepath, this.pattern, wildmatch(filepath, this.pattern));
  if (isMatch) {
    this.found.push(filepath);
  }
  return isMatch;
};

Glob.prototype._process = function(pattern) {
  var self = this,
      prefix = '',
      escaping = false,
      i = 0, c;

  var special = {
    '{': true,
    '[': true,
    '?': true,
    '*': true,
    '@': true,
    '!': true,
    '+': true
  };

  // everything before the first special character is just a prefix.
  // So, we pluck that off.
  if (!special[pattern.charAt(0)]) {
    for (i = 0; i < pattern.length; i++) {
      c = pattern.charAt(i);
      if (c === '\\') {
        escaping = !escaping;
      } else if (special[pattern.charAt(i)] && !escaping) {
        // test/a/abc{fed,def}/g/h => test/a (not test/a/abc)
        var prevSlash = pattern.lastIndexOf('/', i);
        prefix = pattern.substr(0, prevSlash);
        break;
      }
    }
  }

  // now i is the index of the first one that is *not* a string.

  // see if there's anything else
  var read;
  switch(i) {
    case pattern.length:
      this._stat(prefix, function(exists, isDir) {
        // either it's there, or it isn't.
        // nothing more to do, either way.
        if (exists) {
          if (prefix && isAbsolute(prefix) && !this.nomount) {
            if (prefix.charAt(0) === "/") {
              prefix = path.join(this.root, prefix)
            } else {
              prefix = path.resolve(this.root, prefix)
            }
          }

          if (process.platform === "win32")
            prefix = prefix.replace(/\\/g, "/")

          this.matches[index] = this.matches[index] || {}
          this.matches[index][prefix] = true
          this.emitMatch(prefix)
        }
        return cb();
      });
      return;
    case 0:
      // pattern *starts* with some non-trivial item.
      // going to readdir(cwd), but not include the prefix in matches.
      read = ".";

    default:
      // pattern has some string bits in the front.
      // whatever it starts with, whether that's "absolute" like /foo/bar,
      // or "relative" like "../baz"
      read = prefix;
  }

  var strip = '';
   if (isAbsolute(prefix)) {
    if (!prefix) {
      prefix = "/";
    }
    // absolute paths are mounted at this.root
    read = path.join(this.root, prefix);
  } else {
    // relative paths are resolved against this.cwd
    read = path.resolve(this.cwd, prefix);
    strip = this.cwd;
  }

  // now read the directory and all subdirectories:
  // if wildmatch supported partial matches we could prune the tree much earlier
  // Partial means, if you run out of file before you run
  // out of pattern, then that's fine, as long as all
  // the parts match.

  function absToRel(str) {
    return (str.substr(0, strip.length) == strip ? str.substr(strip.length + 1) : str);
  }

  function resolveDir(dirname) {
    // if the input is a directory, add all files in it, but do not add further directories
    var basepath = (dirname[dirname.length - 1] !== path.sep ? dirname + path.sep : dirname);
    self._readdir(basepath, function(err, entries) {
      entries.map(function(f) {
          return basepath + f;
      }).map(function(filepath) {
        self._stat(filepath, function(exists, isDir) {
          // console.log('resolve', filepath, exists, isDir);
          // this where partial matches against a pending traversal would help by pruning the tree
          if (isDir) {
            resolveDir(filepath);
            // try without a trailing slash
            if (!self._filter(absToRel(filepath))) {
              // needed so that wildmatch treats dirs correctly (in some cases)
              if (filepath.charAt(filepath.length) != '/') {
                self._filter(absToRel(filepath + '/'));
              }
            }
          } else if (exists) {
            self._filter(absToRel(filepath));
          }
        });
      });
    });
  }

  this._stat(read, function(exists, isDir) {
    console.log('Initial', read, exists, isDir);
    if (isDir) {
      resolveDir(read);
      // try without a trailing slash
      if (!self._filter(absToRel(read))) {
        // needed so that wildmatch treats dirs correctly (in some cases)
        if (read.charAt(read.length) != '/') {
          self._filter(absToRel(read + '/'));
        }
      }
    } else if (exists) {
      self._filter(absToRel(read));
    };
  });
};

Glob.prototype._stat = function(p, onDone) {
  var stat;
  try {
    stat = fs.statSync(p);
  } catch (e) {
    switch(e.code) {
      case 'ELOOP':
        break;
      default:
        console.error(e);
        console.error(e.stack);
    }
    return onDone(false, false);
  }
  return onDone(!!stat, stat.isDirectory());
};

Glob.prototype._readdir = function(p, onDone) {
  var entries;
  try {
    entries = fs.readdirSync(p);
  } catch (e) {
    switch(e.code) {
      case 'ENOTDIR':
      case 'ENOENT':
      case 'ELOOP':
      case 'ENAMETOOLONG':
      case 'UNKNOWN':
        return onDone(e, []);
      default:
        this.emit('error', e);
        console.error(e);
        console.error(e.stack);
        return onDone(e, []);
    }
  }
  return onDone(null, entries);
};

var isAbsolute = process.platform === "win32" ? absWin : absUnix

function absWin (p) {
  if (absUnix(p)) return true
  // pull off the device/UNC bit from a windows path.
  // from node's lib/path.js
  var splitDeviceRe =
      /^([a-zA-Z]:|[\\\/]{2}[^\\\/]+[\\\/]+[^\\\/]+)?([\\\/])?([\s\S]*?)$/
    , result = splitDeviceRe.exec(p)
    , device = result[1] || ''
    , isUnc = device && device.charAt(1) !== ':'
    , isAbsolute = !!result[2] || isUnc // UNC paths are always absolute

  return isAbsolute
}

function absUnix (p) {
  return p.charAt(0) === "/" || p === ""
}