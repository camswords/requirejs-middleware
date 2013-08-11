var extend = require("extend"),
  fs = require("fs"),
  gaze = require("gaze"),
  mkdirp = require("mkdirp"),
  path = require("path"),
  url = require("url"),
  requirejs = require("requirejs");

function compile(opts, callback) {
  log("compiling now");
  requirejs.optimize(opts,
    function success(build) {
      var deps = build.split("\n").filter(function(line, index) {
        return !!line && index > 2;
      }).map(function(file) {
          return path.normalize(file);
        });

      callback(null, deps);
    }, function error(err) {
      log("compilation failed %j", err);
      callback(err);
    });
}

function compileModules(modules, callback) {
  var moduleNames = Object.keys(modules);
  var errorOccurred = false;

  if (moduleNames.length == 0) {
    callback("attempting to compile modules, but none were found");
  }

  moduleNames.forEach(function(moduleName, index) {
    if (!errorOccurred) {

      compile(modules[moduleName], function(err) {
        if (err) {
          errorOccurred = true;
          callback(err);
        } else if (index == moduleNames.length - 1) {
          callback();
        }
      });
    }
  });
}

// Shhhhh don't say a word
var debugMessages = false;
function log() {
  if (debugMessages) {
    console.log.apply(this, arguments);
  }
}

function setWatchers(module, deps) {
  module._watched = true;

  gaze(deps, function(err, watcher) {
    log("watching %j", watcher.relative());
    watcher.on("all", function(event, filepath) {
      log("%s was %s", filepath, event);
      module._compiled = false;
    });
  });
}

module.exports = function(opts) {
  opts = opts || {};

  if (!opts.src) {
    throw "requirejs-middleware: You must specify a `src` directory";
  }
  if (!opts.dest) {
    throw "requirejs-middleware: You must specify a `dest` directory";
  }
  if (!opts.modules) {
    throw "requirejs-middleware: You must specify atleast one module in `modules`";
  }

  // TODO figure out a less crappy way of setting this
  debugMessages = !!opts.debug;
  var hasCompiled = false;

  opts.defaults = opts.defaults || {};

  Object.keys(opts.modules).forEach(function(key) {
    var module = opts.modules[key];
    module = extend(true, module, opts.defaults);
    module.name = module.name || path.relative(module.baseUrl, __dirname + "/almond");
    module.out = path.join(opts.dest, key);
  });

  return function(req, res, next) {
    if (opts.once) {
      log("using compilation style `once`");

      if (!hasCompiled && /\.js$/.test(url.parse(req.url).pathname)) {
        log("requested a javascript file (" + url.parse(req.url).pathname + "), attempting one off compilation");

        compileModules(opts.modules, function(err) {
          if (err) {
            log("failed to compile modules due to " + err);
          }

          hasCompiled = true;
          next(err);
        });
      } else {
        next();
      }
    }

    if (!opts.once) {

      // Only deal with GET or HEAD requests
      if (req.method.toUpperCase() != "GET" && req.method.toUpperCase() != "HEAD") {
        return next();
      }

      var module = opts.modules[req.path];

      // Is this a require module we're aware of, and has it been compiled?
      if (!module || module._compiled) {
        return next();
      }

      var srcPath = path.join(opts.src, req.path);

      fs.stat(srcPath, function(err, srcStats) {
        // Ignore ENOENT to fall through as 404
        if (err) {
          return next(err.code == "ENOENT" ? null : err);
        }

        // If we're not building with almond, just copy the file to `dest`
        if (!opts.build) {
          var destPath = path.join(opts.dest, req.path);

          mkdirp(path.dirname(destPath), function(err) {
            if (err) {
              log("error creating directory structure %j", err);
              return next(err);
            }

            var reader = fs.createReadStream(srcPath),
              writer = fs.createWriteStream(destPath);

            reader.on("error", function(err) {
              log("error reading file: %j", err);
              next(err);
            });

            writer.on("close", function() {
              log("copied %s into `dest`", req.path);
              if (!module._watched) {
                setWatchers(module, srcPath);
              }

              next();
            });

            writer.on("error", function(err) {
              log("error writing file: %j", err);
              next(err);
            });

            reader.pipe(writer);
          });

          return;
        }

        compile(module, function(err, deps) {
          if (err) {
            return next(err);
          }

          module._compiled = true;

          if (!module._watched) {
            setWatchers(module, deps);
          }

          next();
        });
      });
    }
  };
}
