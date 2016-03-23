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
var asyncMemo = require('asyncmemo')
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
  var innerHTML = html == null ? escapeHTML(parts[parts.length-1]) : html
  return '<a href="' + escapeHTML(href) + '">' + innerHTML + '</a>'
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

function table(props) {
  return function (read) {
    return cat([
      pull.once('<table' + (props ? ' ' + props : '') + '>'),
      pull(
        read,
        pull.map(function (row) {
          return row ? '<tr>' + row.map(function (cell) {
            return '<td>' + cell + '</td>'
          }).join('') + '</tr>' : ''
        })
      ),
      pull.once('</table>')
    ])
  }
}

function ul(props) {
  return function (read) {
    return cat([
      pull.once('<ul' + (props ? ' ' + props : '') + '>'),
      pull(
        read,
        pull.map(function (li) {
          return '<li>' + li + '</li>'
        })
      ),
      pull.once('</ul>')
    ])
  }
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

function getRepoName(about, ownerId, repoId, cb) {
  about.getName({
    owner: ownerId,
    target: repoId,
    toString: function () {
      // hack to fit two parameters into asyncmemo
      return ownerId + '/' + repoId
    }
  }, cb)
}

var hasOwnProp = Object.prototype.hasOwnProperty

function getContentType(filename) {
  var ext = filename.split('.').pop()
  return hasOwnProp.call(contentTypes, ext)
    ? contentTypes[ext]
    : 'text/plain; charset=utf-8'
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
  var ssb, reconnect, myId, getRepo, getVotes, getMsg
  var about = function (id, cb) { cb(null, {name: id}) }
  var reqQueue = []
  var isPublic = opts.public
  var ssbAppname = opts.appname || 'ssb'

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
          getMsg(id, function (err, msg) {
            if (err) return cb(err)
            ssbGit.getRepo(ssb, {key: id, value: msg}, {live: true}, cb)
          })
        })
        getVotes = ssbVotes(ssb)
        getMsg = asyncMemo(ssb.get)
      })
    }
  }

  function onListening() {
    var host = ~addr.host.indexOf(':') ? '[' + addr.host + ']' : addr.host
    console.log('Listening on http://' + host + ':' + addr.port + '/')
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
    var u = req._u = url.parse(req.url)
    var dirs = u.pathname.slice(1).split(/\/+/).map(tryDecodeURIComponent)
    var dir = dirs[0]
    if (dir == '')
      return serveIndex(req)
    else if (ref.isBlobId(dir))
      return serveBlob(req, dir)
    else if (ref.isMsgId(dir))
      return serveMessage(req, dir, dirs.slice(1))
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
        : 'if-modified-since' in req.headers &&
          new Date(req.headers['if-modified-since']) >= stats.mtime ?
          pull.once([304])
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
        'Content-Length': Buffer.byteLength(msg),
        'Content-Type': 'text/plain; charset=utf-8'
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
        'Content-Length': Buffer.byteLength(msg),
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
        '<h1><a href="/">git ssb' +
          (ssbAppname != 'ssb' ? ' <sub>' + ssbAppname + '</sub>' : '') +
        '</a></h1>',
        '</header>',
        '<article>']),
      renderTry(read),
      pull.once('<hr/></article></body></html>')
    ])
  }

  function serveError(err, status) {
    if (err.message == 'stream is closed')
      reconnect()
    return pull(
      pull.once(
        '<h2>' + err.name + '</h3>' +
        '<pre>' + escapeHTML(err.stack) + '</pre>'),
      serveTemplate(err.name, status || 500)
    )
  }

  /* Feed */

  function renderFeed(feedId) {
    var opts = {
      reverse: true,
      id: feedId
    }
    return pull(
      feedId ? ssb.createUserStream(opts) : ssb.createFeedStream(opts),
      pull.filter(function (msg) {
        return msg.value.content.type in msgTypes &&
          msg.value.timestamp < Date.now()
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
    var msgLink = link([msg.key],
      new Date(msg.value.timestamp).toLocaleString())
    var authorLink = link([msg.value.author], authorName)
    var author = msg.value.author
    getRepoName(about, author, msg.key, function (err, repoName) {
      if (err) return cb(err)
      var repoLink = link([msg.key], repoName)
      cb(null, '<section class="collapse">' + msgLink + '<br>' +
        authorLink + ' created repo ' + repoLink + '</section>')
    })
  }

  function renderUpdate(msg, authorName, cb) {
    var msgLink = link([msg.key],
      new Date(msg.value.timestamp).toLocaleString())
    var authorLink = link([msg.value.author], authorName)
    var repoId = msg.value.content.repo
    var author = msg.value.author
    getRepoName(about, author, repoId, function (err, repoName) {
      if (err) return cb(err)
      var repoLink = link([msg.value.content.repo], repoName)
      cb(null, '<section class="collapse">' + msgLink + '<br>' +
        authorLink + ' pushed to ' + repoLink + '</section>')
    })
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

  /* Message */

  function serveMessage(req, id, path) {
    return readNext(function (cb) {
      ssb.get(id, function (err, msg) {
        if (err) return cb(null, serveError(err))
        var c = msg.content || {}
        switch (c.type) {
          case 'git-repo':
            return getRepo(id, function (err, repo) {
              if (err) return cb(null, serveError(err))
              cb(null, serveRepoPage(req, Repo(repo), path))
            })
          case 'git-update':
            return getRepo(c.repo, function (err, repo) {
              if (err) return cb(null, serveRepoNotFound(repo.id, err))
              cb(null, serveRepoUpdate(req, Repo(repo), id, msg, path))
            })
          default:
            if (ref.isMsgId(c.repo))
              return getRepo(c.repo, function (err, repo) {
                if (err) return cb(null, serveRepoNotFound(repo.id, err))
                cb(null, serveRepoSomething(req, Repo(repo), id, msg, path))
              })
            else
              return cb(null, serveGenericMessage(req, id, msg, path))
        }
      })
    })
  }

  function serveGenericMessage(req, id, msg, path) {
    return serveTemplate(id)(pull.once(
      '<section><h2>' + link([id]) + '</h2>' +
      json(msg) +
      '</section>'))
  }

  /* Repo */

  function serveRepoPage(req, repo, path) {
    var defaultBranch = 'master'

    if (req.method == 'POST') {
      if (isPublic)
        return servePlainError(405, 'POST not allowed on public site')
      return readNext(function (cb) {
        readReqJSON(req, function (err, data) {
          if (err) return cb(null, serveError(err, 400))
          if (!data) return cb(null, serveError(new Error('No data'), 400))
          if (data.vote != null) {
            var voteValue = +data.vote || 0
            ssb.publish(schemas.vote(repo.id, voteValue), function (err) {
              if (err) return cb(null, serveError(err))
              cb(null, serveRedirect(req.url))
            })
          } else if ('repo-name' in data) {
            var name = data['repo-name']
            if (!name) return cb(null, serveRedirect(req.url))
            var msg = schemas.name(repo.id, name)
            ssb.publish(msg, function (err) {
              if (err) return cb(null, serveError(err))
              cb(null, serveRedirect(req.url))
            })
          } else {
            cb(null, servePlainError(400, 'What are you trying to do?'))
          }
        })
      })
    }

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
        return serveRepoBlob(repo, branch, filePath)
      case 'raw':
        return serveRepoRaw(repo, branch, filePath)
      case 'digs':
        return serveRepoDigs(repo)
      default:
        return serve404(req)
    }
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
      'value="' + gitUrl + '" size="' + (2 + gitUrl.length) + '" ' +
      'onclick="this.select()"/>'
    var digsPath = [repo.id, 'digs']

    var done = multicb({ pluck: 1, spread: true })
    getRepoName(about, repo.feed, repo.id, done())
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
                '<button type="submit"><i>✌</i> ' +
                  (upvoted ? 'Undig' : 'Dig') +
              '</button>') + ' ' +
              '<strong>' + link(digsPath, votes.upvotes) + '</strong>' +
            '</form>' +
            '<form class="petname" action="" method="post">' +
              (isPublic ? '' :
                '<input name="repo-name" id="repo-name" value="' +
                  escapeHTML(repoName) + '" />' +
                '<label class="repo-name-toggle" for="repo-name" ' +
                  'title="Rename the repo"><i>✍</i></label>' +
                '<input class="repo-name-btn" type="submit" value="Rename">') +
            '<h2 class="left">' + link([repo.feed], authorName) + ' / ' +
              link([repo.id], repoName) + '</h2>' +
            '</form>' +
            '<br clear="all" \>' +
            '</div><div class="repo-nav">' + link([repo.id], 'Code') +
              link([repo.id, 'activity'], 'Activity') +
              link([repo.id, 'commits', branch || ''], 'Commits') +
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
        pull.map(renderRepoUpdate.bind(this, repo))
      )
    ]))
  }

  function renderRepoUpdate(repo, msg, full) {
    var c = msg.value.content

    var refs = c.refs ? Object.keys(c.refs).map(function (ref) {
      return {name: ref, value: c.refs[ref]}
    }) : []
    var numObjects = c.objects ? Object.keys(c.objects).length : 0

    return '<section class="collapse">' +
      link([msg.key], new Date(msg.value.timestamp).toLocaleString()) +
      '<br>' +
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
      pull.once('<h3>Files' + pathLinks + '</h3>'),
      pull(
        repo.readDir(rev, path),
        pull.map(function (file) {
          var type = (file.mode === 040000) ? 'tree' :
            (file.mode === 0160000) ? 'commit' : 'blob'
          if (type == 'commit')
            return ['<span title="git commit link">🖈</span>', '<span title="' + escapeHTML(file.id) + '">' + escapeHTML(file.name) + '</span>']
          var filePath = [repo.id, type, rev].concat(path, file.name)
          return ['<i>' + (type == 'tree' ? '📁' : '📄') + '</i>',
            link(filePath, file.name)]
        }),
        table('class="files"')
      )
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
          repo.getObjectFromAny(file.id, function (err, obj) {
            if (err) return cb(err)
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

  /* An unknown message linking to a repo */

  function serveRepoSomething(req, repo, id, msg, path) {
    return renderRepoPage(repo, null,
      pull.once('<section><h3>' + link([id]) + '</h3>' +
        json(msg) + '</section>'))
  }

  /* Repo update */

  function objsArr(objs) {
    return Array.isArray(objs) ? objs :
      Object.keys(objs).map(function (sha1) {
        var obj = Object.create(objs[sha1])
        obj.sha1 = sha1
        return obj
      })
  }

  function serveRepoUpdate(req, repo, id, msg, path) {
    var raw = String(req._u.query).split('&').indexOf('raw') > -1

    // convert packs to old single-object style
    if (msg.content.indexes) {
      for (var i = 0; i < msg.content.indexes.length; i++) {
        msg.content.packs[i] = {
          pack: {link: msg.content.packs[i].link},
          idx: msg.content.indexes[i]
        }
      }
    }

    return renderRepoPage(repo, null, pull.once(
      (raw ? '<a href="?" class="raw-link header-align">Info</a>' :
        '<a href="?raw" class="raw-link header-align">Data</a>') +
      '<h3>Update</h3>' +
      (raw ? '<section class="collapse">' + json(msg) + '</section>' :
        renderRepoUpdate(repo, {key: id, value: msg}, true) +
        (msg.content.objects ? '<h3>Objects</h3>' +
          objsArr(msg.content.objects).map(renderObject).join('\n') : '') +
        (msg.content.packs ? '<h3>Packs</h3>' +
          msg.content.packs.map(renderPack).join('\n') : ''))))
  }

  function renderObject(obj) {
    return '<section class="collapse">' +
      obj.type + ' ' + link([obj.link], escapeHTML(obj.sha1)) + '<br>' +
      obj.length + ' bytes' +
      '</section>'
  }

  function renderPack(info) {
    return '<section class="collapse">' +
      (info.pack ? 'Pack: ' + link([info.pack.link]) + '<br>' : '') +
      (info.idx ? 'Index: ' + link([info.idx.link]) : '') + '</section>'
  }

  /* Blob */

  function serveRepoBlob(repo, rev, path) {
    return readNext(function (cb) {
      repo.getFile(rev, path, function (err, object) {
        if (err) return cb(null, serveBlobNotFound(repoId, err))
        var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
        var pathLinks = path.length === 0 ? '' :
          ': ' + linkPath([repo.id, 'tree'], [rev].concat(path))
        var rawFilePath = [repo.id, 'raw', rev].concat(path)
        cb(null, renderRepoPage(repo, rev, cat([
          pull.once('<section><h3>' + type + ': ' + rev + ' '),
          revMenu(repo, rev),
          pull.once('</h3>'),
          type == 'Branch' && renderRepoLatest(repo, rev),
          pull.once('</section><section class="collapse">' +
            '<h3>Files' + pathLinks + '</h3>' +
            '<div>' + object.length + ' bytes' +
            '<span class="raw-link">' + link(rawFilePath, 'Raw') + '</span>' +
            '</div></section>' +
            '<section><pre>'),
          pull(object.read, escapeHTMLStream()),
          pull.once('</pre></section>')
        ])))
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

  /* Raw blob */

  function serveRepoRaw(repo, branch, path) {
    return readNext(function (cb) {
      repo.getFile(branch, path, function (err, object) {
        if (err) return cb(null, servePlainError(404, 'Blob not found'))
        cb(null, serveObjectRaw(object))
      })
    })
  }

  function serveRaw(length) {
    var inBody
    var headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'max-age=31536000'
    }
    if (length != null)
      headers['Content-Length'] = length
    return function (read) {
      return function (end, cb) {
        if (inBody) return read(end, cb)
        if (end) return cb(true)
        cb(null, [200, headers])
        inBody = true
      }
    }
  }

  function serveObjectRaw(object) {
    return pull(object.read, serveRaw(object.length))
  }

  function serveBlob(req, key) {
    return readNext(function (cb) {
      ssb.blobs.want(key, function (err, got) {
        if (err) cb(null, serveError(err))
        else if (!got) cb(null, serve404(req))
        else cb(null, serveRaw()(ssb.blobs.get(key)))
      })
    })
  }

  /* Digs */

  function serveRepoDigs(repo) {
    return readNext(function (cb) {
      getVotes(repo.id, function (err, votes) {
        cb(null, renderRepoPage(repo, '', cat([
          pull.once('<section><h3>Digs</h3>' +
            '<div>Total: ' + votes.upvotes + '</div>'),
          pull(
            pull.values(Object.keys(votes.upvoters)),
            pull.asyncMap(function (feedId, cb) {
              about.getName(feedId, function (err, name) {
                if (err) return cb(err)
                cb(null, link([feedId], name))
              })
            }),
            ul()
          ),
          pull.once('</section>')
        ])))
      })
    })
  }
}
