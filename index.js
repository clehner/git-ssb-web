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
var Issues = require('ssb-issues')
var paramap = require('pull-paramap')

var blockRenderer = new marked.Renderer()
blockRenderer.urltransform = function (url) {
  if (ref.isLink(url))
    return encodeLink(url)
  return url
}

marked.setOptions({
  gfm: true,
  mentions: true,
  tables: true,
  breaks: true,
  pedantic: false,
  sanitize: true,
  smartLists: true,
  smartypants: false,
  renderer: blockRenderer
})

function markdown(text) {
  if (!text) return ''
  if (typeof text != 'string') text = String(text)
  return marked(text)
}

function parseAddr(str, def) {
  if (!str) return def
  var i = str.lastIndexOf(':')
  if (~i) return {host: str.substr(0, i), port: str.substr(i+1)}
  if (isNaN(str)) return {host: str, port: def.port}
  return {host: def.host, port: str}
}

function flattenPath(parts) {
  return '/' + parts.map(encodeURIComponent).join('/')
}

function encodeLink(url) {
  return '/' + encodeURIComponent(url)
}

function link(parts, text, raw) {
  var href = flattenPath(parts)
  if (text == null) text = parts[parts.length-1]
  if (!raw) text = escapeHTML(text)
  return '<a href="' + escapeHTML(href) + '">' + text + '</a>'
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

function renderNameForm(enabled, id, name, action, inputId, title, header) {
  if (!inputId) inputId = action
  return '<form class="petname" action="" method="post">' +
    (enabled ?
      '<input type="checkbox" class="name-checkbox" id="' + inputId + '" ' +
        'onfocus="this.form.name.focus()" />' +
      '<input name="name" class="name" value="' + escapeHTML(name) + '" ' +
        'onkeyup="if (event.keyCode == 27) this.form.reset()" />' +
      '<input type="hidden" name="action" value="' + action + '">' +
      '<input type="hidden" name="id" value="' +
        escapeHTML(id) + '">' +
      '<label class="name-toggle" for="' + inputId + '" ' +
        'title="' + title + '"><i>✍</i></label> ' +
      '<input class="btn name-btn" type="submit" value="Rename">' +
      header :
      header + '<br clear="all"/>'
    ) +
  '</form>'
}

function wrap(tag) {
  return function (read) {
    return cat([
      pull.once('<' + tag + '>'),
      read,
      pull.once('</' + tag + '>')
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

function addAuthorName(about) {
  return paramap(function (msg, cb) {
    about.getName(msg.value.author, function (err, authorName) {
      msg.authorName = authorName
      cb(err, msg)
    })
  }, 8)
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
  'git-update': true,
  'issue': true
}

var refLabels = {
  heads: 'Branches',
  tags: 'Tags'
}

var imgMimes = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  svg: 'image/svg+xml',
  bmp: 'image/bmp'
}

var markdownFilenameRegex = /\.md$|\/.markdown$/i

module.exports = function (opts, cb) {
  var ssb, reconnect, myId, getRepo, getVotes, getMsg, issues
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
        issues = Issues.init(ssb)
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
    var u = req._u = url.parse(req.url, true)
    var dirs = u.pathname.slice(1).split(/\/+/).map(tryDecodeURIComponent)
    var dir = dirs[0]

    if (req.method == 'POST') {
      if (isPublic)
        return servePlainError(405, 'POST not allowed on public site')
      return readNext(function (cb) {
        readReqJSON(req, function (err, data) {
          if (err) return cb(null, serveError(err, 400))
          if (!data) return cb(null, serveError(new Error('No data'), 400))

          switch (data.action) {
            case 'vote':
              var voteValue = +data.vote || 0
              if (!data.id)
                return cb(null, serveError(new Error('Missing vote id'), 400))
              var msg = schemas.vote(data.id, voteValue)
              return ssb.publish(msg, function (err) {
                if (err) return cb(null, serveError(err))
                cb(null, serveRedirect(req.url))
              })
              return

          case 'repo-name':
            if (!data.name)
              return cb(null, serveError(new Error('Missing name'), 400))
            if (!data.id)
              return cb(null, serveError(new Error('Missing id'), 400))
            var msg = schemas.name(data.id, data.name)
            return ssb.publish(msg, function (err) {
              if (err) return cb(null, serveError(err))
              cb(null, serveRedirect(req.url))
            })

          case 'issue-title':
            if (!data.name)
              return cb(null, serveError(new Error('Missing name'), 400))
            if (!data.id)
              return cb(null, serveError(new Error('Missing id'), 400))
            var msg = Issues.schemas.edit(data.id, {title: data.name})
            return ssb.publish(msg, function (err) {
              if (err) return cb(null, serveError(err))
              cb(null, serveRedirect(req.url))
            })

          case 'comment':
            if (!data.id)
              return cb(null, serveError(new Error('Missing id'), 400))
            // TODO: add ref mentions
            var msg = schemas.post(data.text, data.id, data.branch || data.id)
            if (data.open != null)
              Issues.schemas.opens(msg, data.id)
            if (data.close != null)
              Issues.schemas.closes(msg, data.id)
            return ssb.publish(msg, function (err) {
              if (err) return cb(null, serveError(err))
              cb(null, serveRedirect(req.url))
            })

          case 'new-issue':
            return issues.new({
              project: dir,
              title: data.title,
              text: data.text
            }, function (err, issue) {
              if (err) return cb(null, serveError(err))
              cb(null, serveRedirect(encodeLink(issue.id)))
            })

          default:
            cb(null, servePlainError(400, 'What are you trying to do?'))
          }
        })
      })
    }

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
      addAuthorName(about),
      pull.asyncMap(renderFeedItem)
    )
  }

  function renderFeedItem(msg, cb) {
    var c = msg.value.content
    var msgLink = link([msg.key],
      new Date(msg.value.timestamp).toLocaleString())
    var author = msg.value.author
    var authorLink = link([msg.value.author], msg.authorName)
    switch (c.type) {
      case 'git-repo':
        return getRepoName(about, author, msg.key, function (err, repoName) {
          if (err) return cb(err)
          var repoLink = link([msg.key], repoName)
          cb(null, '<section class="collapse">' + msgLink + '<br>' +
            authorLink + ' created repo ' + repoLink + '</section>')
        })
      case 'git-update':
        return getRepoName(about, author, c.repo, function (err, repoName) {
          if (err) return cb(err)
          var repoLink = link([c.repo], repoName)
          cb(null, '<section class="collapse">' + msgLink + '<br>' +
            authorLink + ' pushed to ' + repoLink + '</section>')
        })
      case 'issue':
        var issueLink = link([msg.key], c.title)
        return cb(null, '<section class="collapse">' + msgLink + '<br>' +
          authorLink + ' opened issue ' + issueLink + '</section>')
    }
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
              if (err) return cb(null, serveRepoNotFound(c.repo, err))
              cb(null, serveRepoUpdate(req, Repo(repo), id, msg, path))
            })
          case 'issue':
            return getRepo(c.project, function (err, repo) {
              if (err) return cb(null, serveRepoNotFound(c.project, err))
              issues.get(id, function (err, issue) {
                if (err) return cb(null, serveError(err))
                cb(null, serveRepoIssue(req, Repo(repo), issue, path))
              })
            })
          default:
            if (ref.isMsgId(c.repo))
              return getRepo(c.repo, function (err, repo) {
                if (err) return cb(null, serveRepoNotFound(c.repo, err))
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
    var query = req._u.query

    if (query.rev != null) {
      // Allow navigating revs using GET query param.
      // Replace the branch in the path with the rev query value
      path[0] = path[0] || 'tree'
      path[1] = query.rev
      req._u.pathname = flattenPath([repo.id].concat(path))
      delete req._u.query.rev
      delete req._u.search
      return serveRedirect(url.format(req._u))
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
      case 'issues':
        switch (path[1]) {
          case '':
          case undefined:
            return serveRepoIssues(repo, branch, filePath)
          case 'new':
            if (filePath.length == 0)
              return serveRepoNewIssue(repo)
        }
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
            '<form class="right-bar" action="" method="post">' +
              '<button class="btn" ' +
              (isPublic ? 'disabled="disabled"' : ' type="submit"') + '>' +
                '<i>✌</i> ' + (!isPublic && upvoted ? 'Undig' : 'Dig') +
                '</button>' +
              (isPublic ? '' : '<input type="hidden" name="vote" value="' +
                  (upvoted ? '0' : '1') + '">' +
                '<input type="hidden" name="action" value="vote">' +
                '<input type="hidden" name="id" value="' +
                  escapeHTML(repo.id) + '">') + ' ' +
              '<strong>' + link(digsPath, votes.upvotes) + '</strong>' +
            '</form>' +
            renderNameForm(!isPublic, repo.id, repoName, 'repo-name', null,
              'Rename the repo',
              '<h2>' + link([repo.feed], authorName) + ' / ' +
                link([repo.id], repoName) + '</h2>') +
            '</div><div class="repo-nav">' + link([repo.id], 'Code') +
              link([repo.id, 'activity'], 'Activity') +
              link([repo.id, 'commits', branch || ''], 'Commits') +
              link([repo.id, 'issues'], 'Issues') +
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
      pull.once('<section><form action="" method="get">' +
        '<h3>' + type + ': ' + rev + ' '),
      revMenu(repo, rev),
      pull.once('</h3></form>'),
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
              '<strong>' + link(commitPath, commit.title) + '</strong><br>' +
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
    var currentGroup
    return cat([
      pull.once('<select name="rev" onchange="this.form.submit()">'),
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
      pull.once('</select> ' +
        '<noscript><input type="submit" value="Go" /></noscript>')
    ])
  }

  function renderRepoLatest(repo, rev) {
    return readOnce(function (cb) {
      repo.getCommitParsed(rev, function (err, commit) {
        if (err) return cb(err)
        var commitPath = [repo.id, 'commit', commit.id]
        cb(null,
          'Latest: <strong>' + link(commitPath, commit.title) +
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
              markdownFilenameRegex.test(file.name) ?
                readOnce(function (cb) {
                  pull(obj.read, pull.collect(function (err, bufs) {
                    if (err) return cb(err)
                    var buf = Buffer.concat(bufs, obj.length)
                    cb(null, markdown(buf.toString()))
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
            '<p><strong>' + link(commitPath, commit.title) +
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
    var raw = req._u.query.raw != null

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
      obj.type + ' ' + link([obj.link], obj.sha1) + '<br>' +
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
        if (err) return cb(null, serveBlobNotFound(repo.id, err))
        var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
        var pathLinks = path.length === 0 ? '' :
          ': ' + linkPath([repo.id, 'tree'], [rev].concat(path))
        var rawFilePath = [repo.id, 'raw', rev].concat(path)
        var filename = path[path.length-1]
        var extension = filename.split('.').pop()
        cb(null, renderRepoPage(repo, rev, cat([
          pull.once('<section><form action="" method="get">' +
            '<h3>' + type + ': ' + rev + ' '),
          revMenu(repo, rev),
          pull.once('</h3></form>'),
          type == 'Branch' && renderRepoLatest(repo, rev),
          pull.once('</section><section class="collapse">' +
            '<h3>Files' + pathLinks + '</h3>' +
            '<div>' + object.length + ' bytes' +
            '<span class="raw-link">' + link(rawFilePath, 'Raw') + '</span>' +
            '</div></section>' +
            '<section>'),
          extension in imgMimes
          ? pull.once('<img src="' + escapeHTML(flattenPath(rawFilePath)) +
            '" alt="' + escapeHTML(filename) + '" />')
          : markdownFilenameRegex.test(filename)
          ? pull(object.read, escapeHTMLStream(), pull.map(markdown))
          : pull(object.read, escapeHTMLStream(), wrap('pre')),
          pull.once('</section>')
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
        var extension = path[path.length-1].split('.').pop()
        var contentType = imgMimes[extension]
        cb(null, pull(object.read, serveRaw(object.length, contentType)))
      })
    })
  }

  function serveRaw(length, contentType) {
    var inBody
    var headers = {
      'Content-Type': contentType || 'text/plain; charset=utf-8',
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

  /* Issues */

  function serveRepoIssues(repo, issueId, path) {
    var numIssues = 0
    return renderRepoPage(repo, '', cat([
      pull.once(
        (isPublic ? '' :
          '<div class="right-bar">' + link([repo.id, 'issues', 'new'],
            '<button class="btn">&plus; New Issue</button>', true) +
          '</div>') +
        '<h3>Issues</h3>'),
      pull(
        issues.createFeedStream({ project: repo.id }),
        pull.map(function (issue) {
          numIssues++
          return '<section class="collapse">' +
            '<a href="' + encodeLink(issue.id) + '">' +
              escapeHTML(issue.title) +
              '<span class="issue-info">' +
                new Date(issue.created_at).toLocaleString() +
              '</span>' +
            '</a>' +
            '</section>'
        })
      ),
      readOnce(function (cb) {
        cb(null, numIssues > 0 ? '' : '<p>No issues</p>')
      })
    ]))
  }

  /* New Issue */

  function serveRepoNewIssue(repo, issueId, path) {
    return renderRepoPage(repo, '', pull.once(
      '<h3>New Issue</h3>' +
      '<section><form class="new-issue" action="" method="post">' +
      '<input type="hidden" name="action" value="new-issue">' +
      '<p><input class="wide-input" name="title" placeholder="Issue Title" size="69" /></p>' +
      '<p><textarea class="wide-input" name="text" placeholder="Description" rows="12" cols="69"></textarea></p>' +
      '<button type="submit" class="btn">Create</button>' +
      '</form></section>'))
  }

  /* Issue */

  function serveRepoIssue(req, repo, issue, path) {
    var isAuthor = (myId == issue.author) || (myId == repo.feed)
    return renderRepoPage(repo, null, cat([
      pull.once(
        renderNameForm(!isPublic, issue.id, issue.title, 'issue-title', null,
          'Rename the issue',
          '<h3>' + issue.title + '</h3>') +
        '<code>' + issue.id + '</code>' +
        '<section class="collapse">' +
        (issue.open
          ? '<strong class="issue-status open">Open</strong>'
          : '<strong class="issue-status closed">Closed</strong>')),
      readOnce(function (cb) {
        about.getName(issue.author, function (err, authorName) {
          if (err) return cb(err)
          var authorLink = link([issue.author], authorName)
          cb(null,
            authorLink + ' opened this issue on ' + timestamp(issue.created_at) +
            '<hr/>' +
            markdown(issue.text) +
            '</section>')
        })
      }),
      // render posts and edits
      pull(
        ssb.links({
          dest: issue.id,
          values: true
        }),
        pull.unique('key'),
        addAuthorName(about),
        pull.map(function (msg) {
          var authorLink = link([msg.value.author], msg.authorName)
          var msgTimeLink = link([msg.key],
            new Date(msg.value.timestamp).toLocaleString())
          var c = msg.value.content
          switch (c.type) {
            case 'post':
              if (c.root == issue.id) {
                var changed = issues.isStatusChanged(msg, issue)
                return '<section class="collapse">' +
                  authorLink +
                  (changed == null ? '' : ' ' + (
                    changed ? 'reopened this issue' : 'closed this issue')) +
                  ' &middot; ' + msgTimeLink +
                  markdown(c.text) +
                  '</section>'
              } else {
                var text = c.text || (c.type + ' ' + msg.key)
                return '<section class="collapse mention-preview">' +
                  authorLink + ' mentioned this issue in ' +
                  link([msg.key], String(text).substr(0, 140)) +
                  '</section>'
              }
            case 'issue-edit':
              return '<section class="collapse">' +
                (c.title == null ? '' :
                  authorLink + ' renamed this issue to <q>' +
                  escapeHTML(c.title) + '</q>') +
                  ' &middot; ' + msgTimeLink +
                '</section>'
            default:
              return '<section class="collapse">' +
                authorLink +
                ' &middot; ' + msgTimeLink +
                json(c) +
                '</section>'
          }
        })
      ),
      pull.once(isPublic ? '' : '<section><form action="" method="post">' +
        '<input type="hidden" name="action" value="comment">' +
        '<input type="hidden" name="id" value="' + issue.id + '">' +
        '<textarea name="text" class="wide-input" rows="6" cols="69"></textarea>' +
        (isAuthor ?
          '<input type="submit" class="btn"' +
          ' name="' + (issue.open ? 'close' : 'open') + '"' +
          ' value="' + (issue.open ? 'Close issue' : 'Reopen issue') + '"' +
          '/>' : '') +
        '<input type="submit" class="btn open" value="Comment" />' +
      '</form></section>')
    ]))
  }

}
