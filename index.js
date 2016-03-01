var fs = require('fs')
var http = require('http')
var path = require('path')
var url = require('url')
var qs = require('querystring')
var ref = require('ssb-ref')
var pull = require('pull-stream')
var ssbGit = require('ssb-git-repo')
var toPull = require('stream-to-pull-stream')
var cat = require('pull-cat')
var Repo = require('pull-git-repo')
var ssbAbout = require('./about')
var ssbVotes = require('./votes')
var marked = require('ssb-marked')
var asyncMemo = require('./async-memo')
var multicb = require('multicb')
var schemas = require('ssb-msg-schemas')

marked.setOptions({
  gfm: true,
  mentions: true,
  tables: true,
  breaks: true,
  pedantic: false,
  sanitize: true,
  smartLists: true,
  smartypants: false
})

function parseAddr(str, def) {
  if (!str) return def
  var i = str.lastIndexOf(':')
  if (~i) return {host: str.substr(0, i), port: str.substr(i+1)}
  if (isNaN(str)) return {host: str, port: def.port}
  return {host: def.host, port: str}
}

function link(parts, html) {
  var href = '/' + parts.map(encodeURIComponent).join('/')
  var innerHTML = html || escapeHTML(parts[parts.length-1])
  return '<a href="' + href + '">' + innerHTML + '</a>'
}

function timestamp(time) {
  time = Number(time)
  var d = new Date(time)
  return '<span title="' + time + '">' + d.toLocaleString() + '</span>'
}

function pre(text) {
  return '<pre>' + escapeHTML(text) + '</pre>'
}

function json(obj) {
  return pre(JSON.stringify(obj, null, 2))
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHTMLStream() {
  return pull.map(function (buf) {
    return escapeHTML(buf.toString('utf8'))
  })
}

function readNext(fn) {
  var next
  return function (end, cb) {
    if (next) return next(end, cb)
    fn(function (err, _next) {
      if (err) return cb(err)
      next = _next
      next(null, cb)
    })
  }
}

function readOnce(fn) {
  var ended
  return function (end, cb) {
    fn(function (err, data) {
      if (err || ended) return cb(err || ended)
      ended = true
      cb(null, data)
    })
  }
}

function tryDecodeURIComponent(str) {
  if (!str || (str[0] == '%' && ref.isBlobId(str)))
    return str
  try {
    str = decodeURIComponent(str)
  } finally {
    return str
  }
}

function getRepoName(repoId, cb) {
  // TODO: use petnames
  cb(null, repoId.substr(0, 20) + '…')
}

var hasOwnProp = Object.prototype.hasOwnProperty

function getContentType(filename) {
  var ext = filename.split('.').pop()
  return hasOwnProp.call(contentTypes, ext)
    ? contentTypes[ext]
    : 'text/plain'
}

var contentTypes = {
  css: 'text/css'
}

var staticBase = path.join(__dirname, 'static')

function readReqJSON(req, cb) {
  pull(
    toPull(req),
    pull.collect(function (err, bufs) {
      if (err) return cb(err)
      var data
      try {
        data = qs.parse(Buffer.concat(bufs).toString('ascii'))
      } catch(e) {
        return cb(e)
      }
      cb(null, data)
    })
  )
}

var msgTypes = {
  'git-repo': true,
  'git-update': true
}

var refLabels = {
  heads: 'Branches'
}

module.exports = function (opts, cb) {
  var ssb, reconnect, myId, getRepo, getVotes
  var about = function (id, cb) { cb(null, {name: id}) }
  var reqQueue = []
  var isPublic = opts.public

  var addr = parseAddr(opts.listenAddr, {host: 'localhost', port: 7718})
  http.createServer(onRequest).listen(addr.port, addr.host, onListening)

  var server = {
    setSSB: function (_ssb, _reconnect) {
      _ssb.whoami(function (err, feed) {
        if (err) throw err
        ssb = _ssb
        reconnect = _reconnect
        myId = feed.id
        about = ssbAbout(ssb, myId)
        while (reqQueue.length)
          onRequest.apply(this, reqQueue.shift())
        getRepo = asyncMemo(function (id, cb) {
          ssbGit.getRepo(ssb, id, {live: true}, cb)
        })
        getVotes = ssbVotes(ssb)
      })
    }
  }

  function onListening() {
    var host = ~addr.host.indexOf(':') ? '[' + addr.host + ']' : addr.host
    console.error('Listening on http://' + host + ':' + addr.port + '/')
    cb(null, server)
  }

  /* Serving a request */

  function onRequest(req, res) {
    console.log(req.method, req.url)
    if (!ssb) return reqQueue.push(arguments)
    pull(
      handleRequest(req),
      pull.filter(function (data) {
        if (Array.isArray(data)) {
          res.writeHead.apply(res, data)
          return false
        }
        return true
      }),
      toPull(res)
    )
  }

  function handleRequest(req) {
    var u = url.parse(req.url)
    var dirs = u.pathname.slice(1).split(/\/+/).map(tryDecodeURIComponent)
    var dir = dirs[0]
    if (dir == '')
      return serveIndex(req)
    else if (ref.isMsgId(dir))
      return serveRepoPage(req, dir, dirs.slice(1))
    else if (ref.isFeedId(dir))
      return serveUserPage(dir)
    else
      return serveFile(req, dirs)
  }

  function serveFile(req, dirs) {
    var filename = path.join.apply(path, [staticBase].concat(dirs))
    // prevent escaping base dir
    if (filename.indexOf(staticBase) !== 0)
      return servePlainError(403, '403 Forbidden')

    return readNext(function (cb) {
      fs.stat(filename, function (err, stats) {
        cb(null, err ?
          err.code == 'ENOENT' ? serve404(req)
          : servePlainError(500, err.message)
        : stats.isDirectory() ?
          servePlainError(403, 'Directory not listable')
        : cat([
          pull.once([200, {
            'Content-Type': getContentType(filename),
            'Content-Length': stats.size,
            'Last-Modified': stats.mtime.toGMTString()
          }]),
          toPull(fs.createReadStream(filename))
        ]))
      })
    })
  }

  function servePlainError(code, msg) {
    return pull.values([
      [code, {
        'Content-Length': msg.length,
        'Content-Type': 'text/plain'
      }],
      msg
    ])
  }

  function serve404(req) {
    return servePlainError(404, '404 Not Found')
  }

  function serveRedirect(path) {
    var msg = '<!doctype><html><head><meta charset=utf-8>' +
      '<title>Redirect</title></head>' +
      '<body><p><a href="' + path + '">Continue</a></p></body></html>'
    return pull.values([
      [302, {
        'Content-Length': msg.length,
        'Content-Type': 'text/html',
        Location: path
      }],
      msg
    ])
  }

  function renderTry(read) {
    var ended
    return function (end, cb) {
      if (ended) return cb(ended)
      read(end, function (err, data) {
        if (err === true)
          cb(true)
        else if (err) {
          ended = true
          cb(null,
            '<h3>' + err.name + '</h3>' +
            '<pre>' + escapeHTML(err.stack) + '</pre>')
        } else
          cb(null, data)
      })
    }
  }

  function serveTemplate(title, code, read) {
    if (read === undefined) return serveTemplate.bind(this, title, code)
    return cat([
      pull.values([
        [code || 200, {
          'Content-Type': 'text/html'
        }],
        '<!doctype html><html><head><meta charset=utf-8>',
        '<title>' + escapeHTML(title || 'git ssb') + '</title>',
        '<link rel=stylesheet href="/styles.css"/>',
        '</head>\n',
        '<body>',
        '<header>',
        '<h1><a href="/">git ssb</a></h1>',
        '</header>',
        '<article>']),
      renderTry(read),
      pull.once('</article></body></html>')
    ])
  }

  function serveError(err) {
    if (err.message == 'stream is closed')
      reconnect()
    return pull(
      pull.once(
        '<h2>' + err.name + '</h3>' +
        '<pre>' + escapeHTML(err.stack) + '</pre>'),
      serveTemplate(err.name, 500)
    )
  }

  /* Feed */

  function renderFeed(feedId) {
    var opts = {
      reverse: true,
      id: feedId
    }
    return pull(
      feedId ? ssb.createUserStream(opts) : ssb.createLogStream(opts),
      pull.filter(function (msg) {
        return msg.value.content.type in msgTypes
      }),
      pull.take(20),
      pull.asyncMap(function (msg, cb) {
        about.getName(msg.value.author, function (err, name) {
        if (err) return cb(err)
          switch (msg.value.content.type) {
            case 'git-repo': return renderRepoCreated(msg, name, cb)
            case 'git-update': return renderUpdate(msg, name, cb)
          }
        })
      })
    )
  }

  function renderRepoCreated(msg, authorName, cb) {
    var repoLink = link([msg.key])
    var authorLink = link([msg.value.author], authorName)
    cb(null, '<section class="collapse">' + timestamp(msg.value.timestamp) + '<br>' +
      authorLink + ' created repo ' + repoLink + '</section>')
  }

  function renderUpdate(msg, authorName, cb) {
    var repoLink = link([msg.value.content.repo])
    var authorLink = link([msg.value.author], authorName)
    cb(null, '<section class="collapse">' + timestamp(msg.value.timestamp) + '<br>' +
      authorLink + ' pushed to ' + repoLink + '</section>')
  }

  /* Index */

  function serveIndex() {
    return serveTemplate('git ssb')(renderFeed())
  }

  function serveUserPage(feedId) {
    return serveTemplate(feedId)(cat([
      readOnce(function (cb) {
        about.getName(feedId, function (err, name) {
          cb(null, '<h2>' + link([feedId], name) +
          '<code class="user-id">' + feedId + '</code></h2>')
        })
      }),
      renderFeed(feedId),
    ]))
  }

  /* Repo */

  function serveRepoPage(req, id, path) {
    var defaultBranch = 'master'
    return readNext(function (cb) {
      getRepo(id, function (err, repo) {
        if (err) {
          if (0)
            cb(null, serveRepoNotFound(id, err))
          else
            cb(null, serveError(err))
          return
        }
        repo = Repo(repo)

        if (req.method == 'POST') {
          return readReqJSON(req, function (err, data) {
            if (data && data.vote != null) {
              var voteValue = +data.vote || 0
              ssb.publish(schemas.vote(repo.id, voteValue), function (err) {
                if (err) return cb(null, serveError(err))
                cb(null, serveRedirect(req.url))
              })
            } else {
              cb(null, servePlainError(400, 'What are you trying to do?'))
            }
          })
        }

        cb(null, (function () {
          var branch = path[1] || defaultBranch
          var filePath = path.slice(2)
          switch (path[0]) {
            case undefined:
              return serveRepoTree(repo, branch, [])
            case 'activity':
              return serveRepoActivity(repo, branch)
            case 'commits':
              return serveRepoCommits(repo, branch)
            case 'commit':
              return serveRepoCommit(repo, path[1])
            case 'tree':
              return serveRepoTree(repo, branch, filePath)
            case 'blob':
              return serveBlob(repo, branch, filePath)
            default:
              return serve404(req)
          }
        })())
      })
    })
  }

  function serveRepoNotFound(id, err) {
    return serveTemplate('Repo not found', 404, pull.values([
      '<h2>Repo not found</h2>',
      '<p>Repo ' + id + ' was not found</p>',
      '<pre>' + escapeHTML(err.stack) + '</pre>',
    ]))
  }

  function renderRepoPage(repo, branch, body) {
    var gitUrl = 'ssb://' + repo.id
    var gitLink = '<input class="clone-url" readonly="readonly" ' +
      'value="' + gitUrl + '" size="' + gitUrl.length + '" ' +
      'onclick="this.select()"/>'

    var done = multicb({ pluck: 1, spread: true })
    getRepoName(repo.id, done())
    about.getName(repo.feed, done())
    getVotes(repo.id, done())

    return readNext(function (cb) {
      done(function (err, repoName, authorName, votes) {
        if (err) return cb(null, serveError(err))
        var upvoted = votes.upvoters[myId] > 0
        cb(null, serveTemplate(repo.id)(cat([
          pull.once(
            '<div class="repo-title">' +
            '<form class="upvotes" action="" method="post">' +
              (isPublic
              ? '<button disabled="disabled">✌ Dig</button> '
              : '<input type="hidden" name="vote" value="' +
                  (upvoted ? '0' : '1') + '">' +
                '<button type="submit">✌ ' + (upvoted ? 'Undig' : 'Dig') +
              '</button>') +
              '<strong>' + votes.upvotes + '</strong>' +
            '</form>' +
            '<h2>' + link([repo.feed], authorName) + ' / ' +
              link([repo.id], repoName) + '</h2>' +
            '</div><div class="repo-nav">' + link([repo.id], 'Code') +
              link([repo.id, 'activity'], 'Activity') +
              link([repo.id, 'commits', branch], 'Commits') +
              gitLink +
            '</div>'),
          body
        ])))
      })
    })
  }

  function serveRepoTree(repo, rev, path) {
    var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
    return renderRepoPage(repo, rev, cat([
      pull.once('<section><h3>' + type + ': ' + rev + ' '),
      revMenu(repo, rev),
      pull.once('</h3>'),
      type == 'Branch' && renderRepoLatest(repo, rev),
      pull.once('</section><section>'),
      renderRepoTree(repo, rev, path),
      pull.once('</section>'),
      renderRepoReadme(repo, rev, path)
    ]))
  }

  /* Repo activity */

  function serveRepoActivity(repo, branch) {
    return renderRepoPage(repo, branch, cat([
      pull.once('<h3>Activity</h3>'),
      pull(
        ssb.links({
          type: 'git-update',
          dest: repo.id,
          source: repo.feed,
          rel: 'repo',
          values: true,
          reverse: true,
          limit: 8
        }),
        pull.map(renderRepoUpdate)
      )
    ]))

    function renderRepoUpdate(msg) {
      var c = msg.value.content

      var refs = c.refs ? Object.keys(c.refs).map(function (ref) {
        return {name: ref, value: c.refs[ref]}
      }) : []
      var numObjects = c.objects ? Object.keys(c.objects).length : 0

      return '<section class="collapse">' + timestamp(msg.value.timestamp) + '<br>' +
        (numObjects ? 'Pushed ' + numObjects + ' objects<br>' : '') +
        refs.map(function (update) {
          var name = escapeHTML(update.name)
          if (!update.value) {
            return 'Deleted ' + name
          } else {
            var commitLink = link([repo.id, 'commit', update.value])
            return name + ' &rarr; ' + commitLink
          }
        }).join('<br>') +
        '</section>'
    }
  }

  /* Repo commits */

  function serveRepoCommits(repo, branch) {
    return renderRepoPage(repo, branch, cat([
      pull.once('<h3>Commits</h3>'),
      pull(
        repo.readLog(branch),
        pull.asyncMap(function (hash, cb) {
          repo.getCommitParsed(hash, function (err, commit) {
            if (err) return cb(err)
            var commitPath = [repo.id, 'commit', commit.id]
            var treePath = [repo.id, 'tree', commit.id]
            cb(null, '<section class="collapse">' +
              '<strong>' + link(commitPath, escapeHTML(commit.title)) + '</strong><br>' +
              '<code>' + commit.id + '</code> ' +
                link(treePath, 'Tree') + '<br>' +
              (commit.separateAuthor ? escapeHTML(commit.author.name) + ' authored on ' + commit.author.date.toLocaleString() + '<br>' : '') +
              escapeHTML(commit.committer.name) + ' committed on ' + commit.committer.date.toLocaleString() +
              '</section>')
          })
        })
      )
    ]))
  }

  /* Repo tree */

  function revMenu(repo, currentName) {
    var baseHref = '/' + encodeURIComponent(repo.id) + '/tree/'
    var onchange = 'location.href="' + baseHref + '" + this.value'
    var currentGroup
    return cat([
      pull.once('<select onchange="' + escapeHTML(onchange) + '">'),
      pull(
        repo.refs(),
        pull.map(function (ref) {
          var m = ref.name.match(/^refs\/([^\/]*)\/(.*)$/) || [,, ref.name]
          var group = m[1]
          var name = m[2]

          var optgroup = (group === currentGroup) ? '' :
            (currentGroup ? '</optgroup>' : '') +
            '<optgroup label="' + (refLabels[group] || group) + '">'
          currentGroup = group
          var selected = (name == currentName) ? ' selected="selected"' : ''
          var htmlName = escapeHTML(name)
          return optgroup +
            '<option value="' + htmlName + '"' + selected + '>' +
              htmlName + '</option>'
        })
      ),
      readOnce(function (cb) {
        cb(null, currentGroup ? '</optgroup>' : '')
      }),
      pull.once('</select>')
    ])
  }

  function renderRepoLatest(repo, rev) {
    return readOnce(function (cb) {
      repo.getCommitParsed(rev, function (err, commit) {
        if (err) return cb(err)
        var commitPath = [repo.id, 'commit', commit.id]
        cb(null,
          'Latest: <strong>' + link(commitPath, escapeHTML(commit.title)) +
          '</strong><br>' +
          '<code>' + commit.id + '</code><br> ' +
          escapeHTML(commit.committer.name) + ' committed on ' +
          commit.committer.date.toLocaleString() +
          (commit.separateAuthor ? '<br>' +
            escapeHTML(commit.author.name) + ' authored on ' +
            commit.author.date.toLocaleString() : ''))
      })
    })
  }

  // breadcrumbs
  function linkPath(basePath, path) {
    path = path.slice()
    var last = path.pop()
    return path.map(function (dir, i) {
      return link(basePath.concat(path.slice(0, i+1)), dir)
    }).concat(last).join(' / ')
  }

  function renderRepoTree(repo, rev, path) {
    var pathLinks = path.length === 0 ? '' :
      ': ' + linkPath([repo.id, 'tree'], [rev].concat(path))
    return cat([
      pull.once('<h3>Files' + pathLinks + '</h3>' +
        '<ul class="files">'),
      pull(
        repo.readDir(rev, path),
        pull.map(function (file) {
          var type = (file.mode === 040000) ? 'tree' : 'blob'
          var filePath = [repo.id, type, rev].concat(path, file.name)
          var fileName = (type == 'tree') ? file.name + '/' : file.name
          return '<li>' + link(filePath, fileName) + '</li>'
        })
      ),
      pull.once('</ul>')
    ])
  }

  /* Repo readme */

  function renderRepoReadme(repo, branch, path) {
    return readNext(function (cb) {
      pull(
        repo.readDir(branch, path),
        pull.filter(function (file) {
          return /readme(\.|$)/i.test(file.name)
        }),
        pull.take(1),
        pull.collect(function (err, files) {
          if (err) return cb(null, pull.empty())
          var file = files[0]
          if (!file)
            return cb(null, pull.once(path.length ? '' : '<p>No readme</p>'))
          repo.getObject(file.id, function (err, obj) {
            if (err) return cb(null, pull.empty())
            cb(null, cat([
              pull.once('<section><h4>' + escapeHTML(file.name) + '</h4><hr/>'),
              /\.md|\/.markdown/i.test(file.name) ?
                readOnce(function (cb) {
                  pull(obj.read, pull.collect(function (err, bufs) {
                    if (err) return cb(err)
                    var buf = Buffer.concat(bufs, obj.length)
                    cb(null, marked(buf.toString()))
                  }))
                })
              : cat([
                pull.once('<pre>'),
                pull(obj.read, escapeHTMLStream()),
                pull.once('</pre>')
              ]),
              pull.once('</section>')
            ]))
          })
        })
      )
    })
  }

  /* Repo commit */

  function serveRepoCommit(repo, rev) {
    return renderRepoPage(repo, rev, cat([
      pull.once('<h3>Commit ' + rev + '</h3>'),
      readOnce(function (cb) {
        repo.getCommitParsed(rev, function (err, commit) {
          if (err) return cb(err)
          var commitPath = [repo.id, 'commit', commit.id]
          var treePath = [repo.id, 'tree', commit.tree]
          cb(null,
            '<p><strong>' + link(commitPath, escapeHTML(commit.title)) +
              '</strong></p>' +
            pre(commit.body) +
            '<p>' +
            (commit.separateAuthor ? escapeHTML(commit.author.name) +
              ' authored on ' + commit.author.date.toLocaleString() + '<br>'
              : '') +
            escapeHTML(commit.committer.name) + ' committed on ' +
              commit.committer.date.toLocaleString() + '</p>' +
            '<p>' + commit.parents.map(function (id) {
              return 'Parent: ' + link([repo.id, 'commit', id], id)
            }).join('<br>') + '</p>' +
            '<p>' +
              (commit.tree ? 'Tree: ' + link(treePath) : 'No tree') +
            '</p>')
        })
      })
    ]))
  }

  /* Blob */

  function serveBlob(repo, branch, path) {
    return readNext(function (cb) {
      repo.getFile(branch, path, function (err, object) {
        if (err) return cb(null, serveBlobNotFound(repoId, err))
        cb(null, serveObjectRaw(object))
      })
    })
  }

  function serveBlobNotFound(repoId, err) {
    return serveTemplate(400, 'Blob not found', pull.values([
      '<h2>Blob not found</h2>',
      '<p>Blob in repo ' + link([repoId]) + ' was not found</p>',
      '<pre>' + escapeHTML(err.stack) + '</pre>'
    ]))
  }

  function serveObjectRaw(object) {
    return cat([
      pull.once([200, {
        'Content-Length': object.length,
        'Content-Type': 'text/plain'
      }]),
      object.read
    ])
  }

}
