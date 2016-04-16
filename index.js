var fs = require('fs')
var http = require('http')
var path = require('path')
var url = require('url')
var qs = require('querystring')
var util = require('util')
var ref = require('ssb-ref')
var pull = require('pull-stream')
var ssbGit = require('ssb-git-repo')
var toPull = require('stream-to-pull-stream')
var cat = require('pull-cat')
var Repo = require('pull-git-repo')
var ssbAbout = require('./about')
var ssbVotes = require('./votes')
var i18n = require('./i18n')
var marked = require('ssb-marked')
var asyncMemo = require('asyncmemo')
var multicb = require('multicb')
var schemas = require('ssb-msg-schemas')
var Issues = require('ssb-issues')
var PullRequests = require('ssb-pull-requests')
var paramap = require('pull-paramap')
var gitPack = require('pull-git-pack')
var Mentions = require('ssb-mentions')
var Highlight = require('highlight.js')
var JsDiff = require('diff')
var many = require('pull-many')

var hlCssPath = path.resolve(require.resolve('highlight.js'), '../../styles')

// render links to git objects and ssb objects
var blockRenderer = new marked.Renderer()
blockRenderer.urltransform = function (url) {
  if (ref.isLink(url))
    return encodeLink(url)
  if (/^[0-9a-f]{40}$/.test(url) && this.options.repo)
    return encodeLink([this.options.repo.id, 'commit', url])
  return url
}

blockRenderer.image = function (href, title, text) {
  href = href.replace(/^&amp;/, '&')
  var url
  if (ref.isBlobId(href))
    url = encodeLink(href)
  else if (this.options.repo && this.options.rev && this.options.path)
    url = path.join('/', encodeURIComponent(this.options.repo.id),
      'raw', this.options.rev, this.options.path.join('/'), href)
  else
    return text
  return '<img src="' + escapeHTML(url) + '" alt="' + text + '"' +
    (title ? ' title="' + title + '"' : '') + '/>'
}

function getExtension(filename) {
  return (/\.([^.]+)$/.exec(filename) || [,filename])[1]
}

function highlight(code, lang) {
  try {
    return lang
      ? Highlight.highlight(lang, code).value
      : Highlight.highlightAuto(code).value
  } catch(e) {
    if (/^Unknown language/.test(e.message))
      return escapeHTML(code)
    throw e
  }
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
  highlight: highlight,
  renderer: blockRenderer
})

// hack to make git link mentions work
var mdRules = new marked.InlineLexer(1, marked.defaults).rules
mdRules.mention =
  /^(\s)?([@%&][A-Za-z0-9\._\-+=\/]*[A-Za-z0-9_\-+=\/]|[0-9a-f]{40})/
mdRules.text = /^[\s\S]+?(?=[\\<!\[_*`]| {2,}\n| [@%&]|[0-9a-f]{40}|$)/

function markdown(text, options, cb) {
  if (!text) return ''
  if (typeof text != 'string') text = String(text)
  if (!options) options = {}
  else if (options.id) options = {repo: options}
  if (!options.rev) options.rev = 'HEAD'
  if (!options.path) options.path = []

  return marked(text, options, cb)
}

function ParamError(msg) {
  var err = Error.call(this, msg)
  err.name = ParamError.name
  return err
}
util.inherits(ParamError, Error)

function parseAddr(str, def) {
  if (!str) return def
  var i = str.lastIndexOf(':')
  if (~i) return {host: str.substr(0, i), port: str.substr(i+1)}
  if (isNaN(str)) return {host: str, port: def.port}
  return {host: def.host, port: str}
}

function isArray(arr) {
  return Object.prototype.toString.call(arr) == '[object Array]'
}

function encodeLink(url) {
  if (!isArray(url)) url = [url]
  return '/' + url.map(encodeURIComponent).join('/')
}

function link(parts, text, raw, props) {
  if (text == null) text = parts[parts.length-1]
  if (!raw) text = escapeHTML(text)
  return '<a href="' + encodeLink(parts) + '"' +
    (props ? ' ' + props : '') +
    '>' + text + '</a>'
}

function linkify(text) {
  // regex is from ssb-ref
  return text.replace(/(@|%|&|&amp;)[A-Za-z0-9\/+]{43}=\.[\w\d]+/g, function (str) {
    return '<a href="/' + encodeURIComponent(str) + '">' + str + '</a>'
  })
}

function timestamp(time, req) {
  time = Number(time)
  var d = new Date(time)
  return '<span title="' + time + '">' +
    d.toLocaleString(req._locale) + '</span>'
}

function pre(text) {
  return '<pre>' + escapeHTML(text) + '</pre>'
}

function json(obj) {
  return linkify(pre(JSON.stringify(obj, null, 2)))
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

function nav(links, page, after) {
  return ['<nav>'].concat(
    links.map(function (link) {
      var href = typeof link[0] == 'string' ? link[0] : encodeLink(link[0])
      var props = link[2] == page ? ' class="active"' : ''
      return '<a href="' + href + '"' + props + '>' + link[1] + '</a>'
    }), after || '', '</nav>').join('')
}

function renderNameForm(req, enabled, id, name, action, inputId, title, header) {
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
      '<input class="btn name-btn" type="submit" value="' +
        req._t('Rename') + '">' +
      header :
      header + '<br clear="all"/>'
    ) +
  '</form>'
}

function renderPostForm(req, repo, placeholder, rows) {
  return '<input type="radio" class="tab-radio" id="tab1" name="tab" checked="checked"/>' +
  '<input type="radio" class="tab-radio" id="tab2" name="tab"/>' +
  '<div id="tab-links" class="tab-links" style="display:none">' +
    '<label for="tab1" id="write-tab-link" class="tab1-link">' +
      req._t('post.Write') + '</label>' +
    '<label for="tab2" id="preview-tab-link" class="tab2-link">' +
      req._t('post.Preview') + '</label>' +
  '</div>' +
  '<input type="hidden" id="repo-id" value="' + repo.id + '"/>' +
  '<div id="write-tab" class="tab1">' +
    '<textarea id="post-text" name="text" class="wide-input"' +
    ' rows="' + (rows||4) + '" cols="77"' +
    (placeholder ? ' placeholder="' + placeholder + '"' : '') +
    '></textarea>' +
  '</div>' +
  '<div class="preview-text tab2" id="preview-tab"></div>' +
  '<script>' + issueCommentScript + '</script>'
}

function hiddenInputs(values) {
  return Object.keys(values).map(function (key) {
    return '<input type="hidden"' +
      ' name="' + escapeHTML(key) + '"' +
      ' value="' + escapeHTML(values[key]) + '"/>'
  }).join('')
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

function paginate(onFirst, through, onLast, onEmpty) {
  var ended, last, first = true, queue = []
  return function (read) {
    var mappedRead = through(function (end, cb) {
      if (ended = end) return read(ended, cb)
      if (queue.length)
        return cb(null, queue.shift())
      read(null, function (end, data) {
        if (end) return cb(end)
        last = data
        cb(null, data)
      })
    })
    return function (end, cb) {
      var tmp
      if (ended) return cb(ended)
      if (ended = end) return read(ended, cb)
      if (first)
        return read(null, function (end, data) {
          if (ended = end) {
            if (end === true && onEmpty)
              return onEmpty(cb)
            return cb(ended)
          }
          first = false
          last = data
          queue.push(data)
          if (onFirst)
            onFirst(data, cb)
          else
            mappedRead(null, cb)
        })
      mappedRead(null, function (end, data) {
        if (ended = end) {
          if (end === true && last)
            return onLast(last, cb)
        }
        cb(end, data)
      })
    }
  }
}

function readObjectString(obj, cb) {
  pull(obj.read, pull.collect(function (err, bufs) {
    if (err) return cb(err)
    cb(null, Buffer.concat(bufs, obj.length).toString('utf8'))
  }))
}

function getRepoObjectString(repo, id, cb) {
  if (!id) return cb(null, '')
  repo.getObjectFromAny(id, function (err, obj) {
    if (err) return cb(err)
    readObjectString(obj, cb)
  })
}

function compareMsgs(a, b) {
  return (a.value.timestamp - b.value.timestamp) || (a.key - b.key)
}

function pullSort(comparator) {
  return function (read) {
    return readNext(function (cb) {
      pull(read, pull.collect(function (err, items) {
        if (err) return cb(err)
        items.sort(comparator)
        cb(null, pull.values(items))
      }))
    })
  }
}

function sortMsgs() {
  return pullSort(compareMsgs)
}

function pullReverse() {
  return function (read) {
    return readNext(function (cb) {
      pull(read, pull.collect(function (err, items) {
        cb(err, items && pull.values(items.reverse()))
      }))
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

function getRepoFullName(about, author, repoId, cb) {
  var done = multicb({ pluck: 1, spread: true })
  getRepoName(about, author, repoId, done())
  about.getName(author, done())
  done(cb)
}

function addAuthorName(about) {
  return paramap(function (msg, cb) {
    var author = msg && msg.value && msg.value.author
    if (!author) return cb(null, msg)
    about.getName(author, function (err, authorName) {
      msg.authorName = authorName
      cb(err, msg)
    })
  }, 8)
}

function getMention(msg, id) {
  if (msg.key == id) return msg
  var mentions = msg.value.content.mentions
  if (mentions) for (var i = 0; i < mentions.length; i++) {
    var mention = mentions[i]
    if (mention.link == id)
      return mention
  }
  return null
}

var hasOwnProp = Object.prototype.hasOwnProperty

function getContentType(filename) {
  var ext = getExtension(filename)
  return contentTypes[ext] || imgMimes[ext] || 'text/plain; charset=utf-8'
}

var contentTypes = {
  css: 'text/css'
}

function readReqForm(req, cb) {
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

var issueCommentScript = '(' + function () {
  var $ = document.getElementById.bind(document)
  $('tab-links').style.display = 'block'
  $('preview-tab-link').onclick = function (e) {
    with (new XMLHttpRequest()) {
      open('POST', '', true)
      onload = function() {
        $('preview-tab').innerHTML = responseText
      }
      send('action=markdown' +
        '&repo=' + encodeURIComponent($('repo-id').value) +
        '&text=' + encodeURIComponent($('post-text').value))
    }
  }
}.toString() + ')()'

var msgTypes = {
  'git-repo': true,
  'git-update': true,
  'issue': true,
  'pull-request': true
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
        pullReqs = PullRequests.init(ssb)
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
    req._u = url.parse(req.url, true)
    var locale = req._u.query.locale ||
      (/locale=([^;]*)/.exec(req.headers.cookie) || [])[1]
    var reqLocales = req.headers['accept-language']
    i18n.pickCatalog(reqLocales, locale, function (err, t) {
      if (err) return pull(serveError(req, err, 500), serve(req, res))
      req._t = t
      req._locale = t.locale
      pull(handleRequest(req), serve(req, res))
    })
  }

  function serve(req, res) {
    return pull(
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
    var path = req._u.pathname.slice(1)
    var dirs = ref.isLink(path) ? [path] :
      path.split(/\/+/).map(tryDecodeURIComponent)
    var dir = dirs[0]

    if (req.method == 'POST') {
      if (isPublic)
        return serveBuffer(405, req._t('error.POSTNotAllowed'))
      return readNext(function (cb) {
        readReqForm(req, function (err, data) {
          if (err) return cb(null, serveError(req, err, 400))
          if (!data) return cb(null, serveError(req,
            new ParamError(req._t('error.MissingData')), 400))

          switch (data.action) {
            case 'fork-prompt':
              return cb(null, serveRedirect(req,
                encodeLink([data.id, 'fork'])))

            case 'fork':
              if (!data.id)
                return cb(null, serveError(req,
                  new ParamError(req._t('error.MissingId')), 400))
              return ssbGit.createRepo(ssb, {upstream: data.id},
                function (err, repo) {
                  if (err) return cb(null, serveError(req, err))
                  cb(null, serveRedirect(req, encodeLink(repo.id)))
                })

            case 'vote':
              var voteValue = +data.value || 0
              if (!data.id)
                return cb(null, serveError(req,
                  new ParamError(req._t('error.MissingId')), 400))
              var msg = schemas.vote(data.id, voteValue)
              return ssb.publish(msg, function (err) {
                if (err) return cb(null, serveError(req, err))
                cb(null, serveRedirect(req, req.url))
              })

          case 'repo-name':
            if (!data.id)
              return cb(null, serveError(req,
                new ParamError(req._t('error.MissingId')), 400))
            if (!data.name)
              return cb(null, serveError(req,
                new ParamError(req._t('error.MissingName')), 400))
            var msg = schemas.name(data.id, data.name)
            return ssb.publish(msg, function (err) {
              if (err) return cb(null, serveError(req, err))
              cb(null, serveRedirect(req, req.url))
            })

          case 'issue-title':
            if (!data.id)
              return cb(null, serveError(req,
                new ParamError(req._t('error.MissingId')), 400))
            if (!data.name)
              return cb(null, serveError(req,
                new ParamError(req._t('error.MissingName')), 400))
            var msg = Issues.schemas.edit(data.id, {title: data.name})
            return ssb.publish(msg, function (err) {
              if (err) return cb(null, serveError(req, err))
              cb(null, serveRedirect(req, req.url))
            })

          case 'comment':
            if (!data.id)
              return cb(null, serveError(req,
                new ParamError(req._t('error.MissingId')), 400))
            var msg = schemas.post(data.text, data.id, data.branch || data.id)
            msg.issue = data.issue
            msg.repo = data.repo
            if (data.open != null)
              Issues.schemas.opens(msg, data.id)
            if (data.close != null)
              Issues.schemas.closes(msg, data.id)
            var mentions = Mentions(data.text)
            if (mentions.length)
              msg.mentions = mentions
            return ssb.publish(msg, function (err) {
              if (err) return cb(null, serveError(req, err))
              cb(null, serveRedirect(req, req.url))
            })

          case 'new-issue':
            var msg = Issues.schemas.new(dir, data.title, data.text)
            var mentions = Mentions(data.text)
            if (mentions.length)
              msg.mentions = mentions
            return ssb.publish(msg, function (err, msg) {
              if (err) return cb(null, serveError(req, err))
              cb(null, serveRedirect(req, encodeLink(msg.key)))
            })

          case 'new-pull':
            var msg = PullRequests.schemas.new(dir, data.branch,
              data.head_repo, data.head_branch, data.title, data.text)
            var mentions = Mentions(data.text)
            if (mentions.length)
              msg.mentions = mentions
            return ssb.publish(msg, function (err, msg) {
              if (err) return cb(null, serveError(req, err))
              cb(null, serveRedirect(req, encodeLink(msg.key)))
            })

          case 'markdown':
            return cb(null, serveMarkdown(data.text, {id: data.repo}))

          default:
            cb(null, serveBuffer(400, req._t('error.UnknownAction', data)))
          }
        })
      })
    }

    if (dir == '')
      return serveIndex(req)
    else if (dir == 'search')
      return serveSearch(req)
    else if (ref.isBlobId(dir))
      return serveBlob(req, dir)
    else if (ref.isMsgId(dir))
      return serveMessage(req, dir, dirs.slice(1))
    else if (ref.isFeedId(dir))
      return serveUserPage(req, dir, dirs.slice(1))
    else if (dir == 'static')
      return serveFile(req, dirs)
    else if (dir == 'highlight')
      return serveFile(req, [hlCssPath].concat(dirs.slice(1)), true)
    else
      return serve404(req)
  }

  function serveFile(req, dirs, outside) {
    var filename = path.resolve.apply(path, [__dirname].concat(dirs))
    // prevent escaping base dir
    if (!outside && filename.indexOf('../') === 0)
      return serveBuffer(403, req._t("error.403Forbidden"))

    return readNext(function (cb) {
      fs.stat(filename, function (err, stats) {
        cb(null, err ?
          err.code == 'ENOENT' ? serve404(req)
          : serveBuffer(500, err.message)
        : 'if-modified-since' in req.headers &&
          new Date(req.headers['if-modified-since']) >= stats.mtime ?
          pull.once([304])
        : stats.isDirectory() ?
          serveBuffer(403, req._t('error.DirectoryNotListable'))
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

  function serveBuffer(code, buf, contentType, headers) {
    headers = headers || {}
    headers['Content-Type'] = contentType || 'text/plain; charset=utf-8'
    headers['Content-Length'] = Buffer.byteLength(buf)
    return pull.values([
      [code, headers],
      buf
    ])
  }

  function serve404(req) {
    return serveBuffer(404, req._t("error.404NotFound"))
  }

  function serveRedirect(req, path) {
    return serveBuffer(302,
      '<!doctype><html><head>' +
      '<title>' + req._t('Redirect') + '</title></head><body>' +
      '<p><a href="' + escapeHTML(path) + '">' +
        req._t('Continue') + '</a></p>' +
      '</body></html>', 'text/html; charset=utf-8', {Location: path})
  }

  function serveMarkdown(text, repo) {
    return serveBuffer(200, markdown(text, repo), 'text/html; charset=utf-8')
  }

  function renderError(err, tag) {
    tag = tag || 'h3'
    return '<' + tag + '>' + err.name + '</' + tag + '>' +
      '<pre>' + escapeHTML(err.stack) + '</pre>'
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
          cb(null, renderError(err, 'h3'))
        } else
          cb(null, data)
      })
    }
  }

  function serveTemplate(req, title, code, read) {
    if (read === undefined) return serveTemplate.bind(this, req, title, code)
    var q = req._u.query.q && escapeHTML(req._u.query.q) || ''
    var app = 'git ssb'
    if (req._t) app = req._t(app)
    return cat([
      pull.values([
        [code || 200, {
          'Content-Type': 'text/html'
        }],
        '<!doctype html><html><head><meta charset=utf-8>',
        '<title>' + (title || app) + '</title>',
        '<link rel=stylesheet href="/static/styles.css"/>',
        '<link rel=stylesheet href="/highlight/github.css"/>',
        '</head>\n',
        '<body>',
        '<header><form action="/search" method="get">' +
        '<h1><a href="/">' + app + '' +
          (ssbAppname != 'ssb' ? ' <sub>' + ssbAppname + '</sub>' : '') +
        '</a> ' +
        '<input class="search-bar" name="q" size="60"' +
          ' placeholder="🔍" value="' + q + '" />' +
        '</h1>',
        '</form></header>',
        '<article>']),
      renderTry(read),
      pull.once('<hr/></article></body></html>')
    ])
  }

  function serveError(req, err, status) {
    if (err.message == 'stream is closed')
      reconnect()
    return pull(
      pull.once(renderError(err, 'h2')),
      serveTemplate(req, err.name, status || 500)
    )
  }

  function renderObjectData(obj, filename, repo, rev, path) {
    var ext = getExtension(filename)
    return readOnce(function (cb) {
      readObjectString(obj, function (err, buf) {
        buf = buf.toString('utf8')
        if (err) return cb(err)
        cb(null, (ext == 'md' || ext == 'markdown')
          ? markdown(buf, {repo: repo, rev: rev, path: path})
          : renderCodeTable(buf, ext))
      })
    })
  }

  function renderCodeTable(buf, ext) {
    return '<pre><table class="code">' +
      highlight(buf, ext).split('\n').map(function (line, i) {
        i++
        return '<tr id="L' + i + '">' +
          '<td class="code-linenum">' + '<a href="#L' + i + '">' + i + '</td>' +
          '<td class="code-text">' + line + '</td></tr>'
      }).join('') +
      '</table></pre>'
  }

  /* Feed */

  function renderFeed(req, feedId, filter) {
    var query = req._u.query
    var opts = {
      reverse: !query.forwards,
      lt: query.lt && +query.lt || Date.now(),
      gt: query.gt && +query.gt,
      id: feedId
    }
    return pull(
      feedId ? ssb.createUserStream(opts) : ssb.createFeedStream(opts),
      pull.filter(function (msg) {
        return msg.value.content.type in msgTypes
      }),
      typeof filter == 'function' ? filter(opts) : filter,
      pull.take(20),
      addAuthorName(about),
      query.forwards && pullReverse(),
      paginate(
        function (first, cb) {
          if (!query.lt && !query.gt) return cb(null, '')
          var gt = feedId ? first.value.sequence : first.value.timestamp + 1
          query.gt = gt
          query.forwards = 1
          delete query.lt
          cb(null, '<a href="?' + qs.stringify(query) + '">' +
            req._t('Newer') + '</a>')
        },
        paramap(renderFeedItem.bind(null, req), 8),
        function (last, cb) {
          query.lt = feedId ? last.value.sequence : last.value.timestamp - 1
          delete query.gt
          delete query.forwards
          cb(null, '<a href="?' + qs.stringify(query) + '">' +
            req._t('Older') + '</a>')
        },
        function (cb) {
          if (query.forwards) {
            delete query.gt
            delete query.forwards
            query.lt = opts.gt + 1
          } else {
            delete query.lt
            query.gt = opts.lt - 1
            query.forwards = 1
          }
          cb(null, '<a href="?' + qs.stringify(query) + '">' +
            req._t(query.forwards ? 'Older' : 'Newer') + '</a>')
        }
      )
    )
  }

  function renderFeedItem(req, msg, cb) {
    var c = msg.value.content
    var msgLink = link([msg.key],
      new Date(msg.value.timestamp).toLocaleString(req._locale))
    var author = msg.value.author
    var authorLink = link([msg.value.author], msg.authorName)
    switch (c.type) {
      case 'git-repo':
        var done = multicb({ pluck: 1, spread: true })
        getRepoName(about, author, msg.key, done())
        if (c.upstream) {
          return getMsg(c.upstream, function (err, upstreamMsg) {
            if (err) return cb(null, serveError(req, err))
            getRepoName(about, upstreamMsg.author, c.upstream, done())
            done(function (err, repoName, upstreamName) {
              cb(null, '<section class="collapse">' + msgLink + '<br>' +
                req._t('Forked', {
                  name: authorLink,
                  upstream: link([c.upstream], upstreamName),
                  repo: link([msg.key], repoName)
                }) + '</section>')
            })
          })
        } else {
          return done(function (err, repoName) {
            if (err) return cb(err)
            var repoLink = link([msg.key], repoName)
            cb(null, '<section class="collapse">' + msgLink + '<br>' +
              req._t('CreatedRepo', {
                name: authorLink,
                repo: repoLink
              }) + '</section>')
          })
        }
      case 'git-update':
        return getRepoName(about, author, c.repo, function (err, repoName) {
          if (err) return cb(err)
          var repoLink = link([c.repo], repoName)
          cb(null, '<section class="collapse">' + msgLink + '<br>' +
            req._t('Pushed', {
              name: authorLink,
              repo: repoLink
            }) + '</section>')
        })
      case 'issue':
      case 'pull-request':
        var issueLink = link([msg.key], c.title)
        return getMsg(c.project, function (err, projectMsg) {
          if (err) return cb(null, serveRepoNotFound(req, c.repo, err))
          getRepoName(about, projectMsg.author, c.project,
            function (err, repoName) {
              if (err) return cb(err)
              var repoLink = link([c.project], repoName)
              cb(null, '<section class="collapse">' + msgLink + '<br>' +
                req._t('OpenedIssue', {
                  name: authorLink,
                  type: req._t(c.type == 'pull-request' ?
                    'pull request' : 'issue.'),
                  title: issueLink,
                  project: repoLink
                }) + '</section>')
            })
        })
      case 'about':
        return cb(null, '<section class="collapse">' + msgLink + '<br>' +
          req._t('Named', {
            author: authorLink,
            target: '<tt>' + escapeHTML(c.about) + '</tt>',
            name: link([c.about], c.name)
          }) + '</section>')
      default:
        return cb(null, json(msg))
    }
  }

  /* Index */

  function serveIndex(req) {
    return serveTemplate(req)(renderFeed(req))
  }

  function serveUserPage(req, feedId, dirs) {
    switch (dirs[0]) {
      case undefined:
      case '':
      case 'activity':
        return serveUserActivity(req, feedId)
      case 'repos':
        return serveUserRepos(req, feedId)
    }
  }

  function renderUserPage(req, feedId, page, body) {
    return serveTemplate(req, feedId)(cat([
      readOnce(function (cb) {
        about.getName(feedId, function (err, name) {
          cb(null, '<h2>' + link([feedId], name) +
          '<code class="user-id">' + feedId + '</code></h2>' +
          nav([
            [[feedId], req._t('Activity'), 'activity'],
            [[feedId, 'repos'], req._t('Repos'), 'repos']
          ], page))
        })
      }),
      body,
    ]))
  }

  function serveUserActivity(req, feedId) {
    return renderUserPage(req, feedId, 'activity', renderFeed(req, feedId))
  }

  function serveUserRepos(req, feedId) {
    return renderUserPage(req, feedId, 'repos', pull(
      ssb.messagesByType({
        type: 'git-repo',
        reverse: true
      }),
      pull.filter(function (msg) {
        return msg.value.author == feedId
      }),
      pull.take(20),
      paramap(function (msg, cb) {
        var done = multicb({ pluck: 1, spread: true })
        getRepoName(about, feedId, msg.key, done())
        getVotes(msg.key, done())
        done(function (err, repoName, votes) {
          if (err) return cb(err)
          cb(null, '<section class="collapse">' +
            '<span class="right-bar">' +
            '<i>✌</i> ' +
            link([msg.key, 'digs'], votes.upvotes, true,
              ' title="' + req._t('Digs') + '"') +
            '</span>' +
            link([msg.key], repoName) +
          '</section>')
        })
      }, 8)
    ))
  }

  /* Message */

  function serveMessage(req, id, path) {
    return readNext(function (cb) {
      ssb.get(id, function (err, msg) {
        if (err) return cb(null, serveError(req, err))
        var c = msg.content || {}
        switch (c.type) {
          case 'git-repo':
            return getRepo(id, function (err, repo) {
              if (err) return cb(null, serveError(req, err))
              cb(null, serveRepoPage(req, Repo(repo), path))
            })
          case 'git-update':
            return getRepo(c.repo, function (err, repo) {
              if (err) return cb(null, serveRepoNotFound(req, c.repo, err))
              cb(null, serveRepoUpdate(req, Repo(repo), id, msg, path))
            })
          case 'issue':
            return getRepo(c.project, function (err, repo) {
              if (err) return cb(null, serveRepoNotFound(req, c.project, err))
              issues.get(id, function (err, issue) {
                if (err) return cb(null, serveError(req, err))
                cb(null, serveRepoIssue(req, Repo(repo), issue, path))
              })
            })
          case 'pull-request':
            return getRepo(c.repo, function (err, repo) {
              if (err) return cb(null, serveRepoNotFound(req, c.project, err))
              pullReqs.get(id, function (err, pr) {
                if (err) return cb(null, serveError(req, err))
                cb(null, serveRepoPullReq(req, Repo(repo), pr, path))
              })
            })
          case 'issue-edit':
            if (ref.isMsgId(c.issue)) {
              return pullReqs.get(c.issue, function (err, issue) {
                if (err) return cb(err)
                var serve = issue.msg.value.content.type == 'pull-request' ?
                  serveRepoPullReq : serveRepoIssue
                getRepo(issue.project, function (err, repo) {
                  if (err) {
                    if (!repo) return cb(null,
                      serveRepoNotFound(req, c.repo, err))
                    return cb(null, serveError(req, err))
                  }
                  cb(null, serve(req, Repo(repo), issue, path, id))
                })
              })
            }
            // fallthrough
          case 'post':
            if (ref.isMsgId(c.issue) && ref.isMsgId(c.repo)) {
              // comment on an issue
              var done = multicb({ pluck: 1, spread: true })
              getRepo(c.repo, done())
              pullReqs.get(c.issue, done())
              return done(function (err, repo, issue) {
                if (err) {
                  if (!repo) return cb(null,
                    serveRepoNotFound(req, c.repo, err))
                  return cb(null, serveError(req, err))
                }
                var serve = issue.msg.value.content.type == 'pull-request' ?
                  serveRepoPullReq : serveRepoIssue
                cb(null, serve(req, Repo(repo), issue, path, id))
              })
            } else if (ref.isMsgId(c.root)) {
              // comment on issue from patchwork?
              return getMsg(c.root, function (err, root) {
                if (err) return cb(null, serveError(req, err))
                var repoId = root.content.repo || root.content.project
                if (!ref.isMsgId(repoId))
                  return cb(null, serveGenericMessage(req, id, msg, path))
                getRepo(repoId, function (err, repo) {
                  if (err) return cb(null, serveError(req, err))
                  switch (root.content && root.content.type) {
                    case 'issue':
                      return issues.get(c.root, function (err, issue) {
                        if (err) return cb(null, serveError(req, err))
                        return cb(null,
                          serveRepoIssue(req, Repo(repo), issue, path, id))
                      })
                    case 'pull-request':
                      pullReqs.get(c.root, function (err, pr) {
                        if (err) return cb(null, serveError(req, err))
                        return cb(null,
                          serveRepoPullReq(req, Repo(repo), pr, path, id))
                      })
                  }
                })
              })
            }
            // fallthrough
          default:
            if (ref.isMsgId(c.repo))
              return getRepo(c.repo, function (err, repo) {
                if (err) return cb(null, serveRepoNotFound(req, c.repo, err))
                cb(null, serveRepoSomething(req, Repo(repo), id, msg, path))
              })
            else
              return cb(null, serveGenericMessage(req, id, msg, path))
        }
      })
    })
  }

  function serveGenericMessage(req, id, msg, path) {
    return serveTemplate(req, id)(pull.once(
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
      req._u.pathname = encodeLink([repo.id].concat(path))
      delete req._u.query.rev
      delete req._u.search
      return serveRedirect(req, url.format(req._u))
    }

    // get branch
    return path[1] ?
      serveRepoPage2(req, repo, path) :
      readNext(function (cb) {
        // TODO: handle this in pull-git-repo or ssb-git-repo
        repo.getSymRef('HEAD', true, function (err, ref) {
          if (err) return cb(err)
          repo.resolveRef(ref, function (err, rev) {
            path[1] = rev ? ref : null
            cb(null, serveRepoPage2(req, repo, path))
          })
        })
      })
  }

  function serveRepoPage2(req, repo, path) {
    var branch = path[1]
    var filePath = path.slice(2)
    switch (path[0]) {
      case undefined:
      case '':
        return serveRepoTree(req, repo, branch, [])
      case 'activity':
        return serveRepoActivity(req, repo, branch)
      case 'commits':
        return serveRepoCommits(req, repo, branch)
      case 'commit':
        return serveRepoCommit(req, repo, path[1])
      case 'tree':
        return serveRepoTree(req, repo, branch, filePath)
      case 'blob':
        return serveRepoBlob(req, repo, branch, filePath)
      case 'raw':
        return serveRepoRaw(req, repo, branch, filePath)
      case 'digs':
        return serveRepoDigs(req, repo)
      case 'fork':
        return serveRepoForkPrompt(req, repo)
      case 'forks':
        return serveRepoForks(req, repo)
      case 'issues':
        switch (path[1]) {
          case 'new':
            if (filePath.length == 0)
              return serveRepoNewIssue(req, repo)
            break
          default:
            return serveRepoIssues(req, repo, filePath)
        }
      case 'pulls':
        return serveRepoPullReqs(req, repo)
      case 'compare':
        return serveRepoCompare(req, repo)
      case 'comparing':
        return serveRepoComparing(req, repo)
      default:
        return serve404(req)
    }
  }

  function serveRepoNotFound(req, id, err) {
    return serveTemplate(req, req._t('error.RepoNotFound'), 404)(pull.values([
      '<h2>' + req._t('error.RepoNotFound') + '</h2>',
      '<p>' + req._t('error.RepoNameNotFound') + '</p>',
      '<pre>' + escapeHTML(err.stack) + '</pre>'
    ]))
  }

  function renderRepoPage(req, repo, page, branch, body) {
    var gitUrl = 'ssb://' + repo.id
    var gitLink = '<input class="clone-url" readonly="readonly" ' +
      'value="' + gitUrl + '" size="45" ' +
      'onclick="this.select()"/>'
    var digsPath = [repo.id, 'digs']

    var done = multicb({ pluck: 1, spread: true })
    getRepoName(about, repo.feed, repo.id, done())
    about.getName(repo.feed, done())
    getVotes(repo.id, done())

    if (repo.upstream) {
      getRepoName(about, repo.upstream.feed, repo.upstream.id, done())
      about.getName(repo.upstream.feed, done())
    }

    return readNext(function (cb) {
      done(function (err, repoName, authorName, votes,
          upstreamName, upstreamAuthorName) {
        if (err) return cb(null, serveError(req, err))
        var upvoted = votes.upvoters[myId] > 0
        var upstreamLink = !repo.upstream ? '' :
          link([repo.upstream])
        cb(null, serveTemplate(req, repo.id)(cat([
          pull.once(
            '<div class="repo-title">' +
            '<form class="right-bar" action="" method="post">' +
              '<button class="btn" name="action" value="vote" ' +
              (isPublic ? 'disabled="disabled"' : ' type="submit"') + '>' +
                '<i>✌</i> ' + req._t(!isPublic && upvoted ? 'Undig' : 'Dig') +
                '</button>' +
              (isPublic ? '' : '<input type="hidden" name="value" value="' +
                  (upvoted ? '0' : '1') + '">' +
                '<input type="hidden" name="id" value="' +
                  escapeHTML(repo.id) + '">') + ' ' +
              '<strong>' + link(digsPath, votes.upvotes) + '</strong> ' +
              (isPublic ? '' : '<button class="btn" type="submit" ' +
                  ' name="action" value="fork-prompt">' +
                '<i>⑂</i> ' + req._t('Fork') +
                '</button>') + ' ' +
              link([repo.id, 'forks'], '+', false, ' title="' +
                req._t('Forks') + '"') +
            '</form>' +
            renderNameForm(req, !isPublic, repo.id, repoName, 'repo-name',
              null, req._t('repo.Rename'),
              '<h2 class="bgslash">' + link([repo.feed], authorName) + ' / ' +
                link([repo.id], repoName) + '</h2>') +
            '</div>' +
            (repo.upstream ? '<small class="bgslash">' + req._t('ForkedFrom', {
              repo: link([repo.upstream.feed], upstreamAuthorName) + '/' +
                link([repo.upstream.id], upstreamName)
            }) + '</small>' : '') +
            nav([
              [[repo.id], req._t('Code'), 'code'],
              [[repo.id, 'activity'], req._t('Activity'), 'activity'],
              [[repo.id, 'commits', branch||''], req._t('Commits'), 'commits'],
              [[repo.id, 'issues'], req._t('Issues'), 'issues'],
              [[repo.id, 'pulls'], req._t('PullRequests'), 'pulls']
            ], page, gitLink)),
          body
        ])))
      })
    })
  }

  function serveEmptyRepo(req, repo) {
    if (repo.feed != myId)
      return renderRepoPage(req, repo, 'code', null, pull.once(
        '<section>' +
        '<h3>' + req._t('EmptyRepo') + '</h3>' +
        '</section>'))

    var gitUrl = 'ssb://' + repo.id
    return renderRepoPage(req, repo, 'code', null, pull.once(
      '<section>' +
      '<h3>' + req._t('initRepo.GettingStarted') + '</h3>' +
      '<h4>' + req._t('initRepo.CreateNew') + '</h4><pre>' +
      'touch ' + req._t('initRepo.README') + '.md\n' +
      'git init\n' +
      'git add ' + req._t('initRepo.README') + '.md\n' +
      'git commit -m "' + req._t('initRepo.InitialCommit') + '"\n' +
      'git remote add origin ' + gitUrl + '\n' +
      'git push -u origin master</pre>\n' +
      '<h4>' + req._t('initRepo.PushExisting') + '</h4>\n' +
      '<pre>git remote add origin ' + gitUrl + '\n' +
      'git push -u origin master</pre>' +
      '</section>'))
  }

  function serveRepoTree(req, repo, rev, path) {
    if (!rev) return serveEmptyRepo(req, repo)
    var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
    return renderRepoPage(req, repo, 'code', rev, cat([
      pull.once('<section><form action="" method="get">' +
        '<h3>' + req._t(type) + ': ' + rev + ' '),
      revMenu(req, repo, rev),
      pull.once('</h3></form>'),
      type == 'Branch' && renderRepoLatest(req, repo, rev),
      pull.once('</section><section>'),
      renderRepoTree(req, repo, rev, path),
      pull.once('</section>'),
      renderRepoReadme(req, repo, rev, path)
    ]))
  }

  /* Search */

  function serveSearch(req) {
    var q = String(req._u.query.q || '')
    if (!q) return serveIndex(req)
    var qId = q.replace(/^ssb:\/*/, '')
    if (ref.type(qId))
      return serveRedirect(req, encodeURI(qId))

    var search = new RegExp(q, 'i')
    return serveTemplate(req, req._t('Search') + ' &middot; ' + q, 200)(
      renderFeed(req, null, function (opts) {
        opts.type == 'about'
        return function (read) {
          return pull(
            many([
              getRepoNames(opts),
              read
            ]),
            pull.filter(function (msg) {
              var c = msg.value.content
              return (
                search.test(msg.key) ||
                c.text && search.test(c.text) ||
                c.name && search.test(c.name) ||
                c.title && search.test(c.title))
            })
          )
        }
      })
    )
  }

  function getRepoNames(opts) {
    return pull(
      ssb.messagesByType({
        type: 'about',
        reverse: opts.reverse,
        lt: opts.lt,
        gt: opts.gt,
      }),
      pull.filter(function (msg) {
        return '%' == String(msg.value.content.about)[0]
          && msg.value.content.name
      })
    )
  }

  /* Repo activity */

  function serveRepoActivity(req, repo, branch) {
    return renderRepoPage(req, repo, 'activity', branch, cat([
      pull.once('<h3>' + req._t('Activity') + '</h3>'),
      pull(
        ssb.links({
          dest: repo.id,
          source: repo.feed,
          rel: 'repo',
          values: true,
          reverse: true
        }),
        pull.map(renderRepoUpdate.bind(this, req, repo))
      ),
      readOnce(function (cb) {
        var done = multicb({ pluck: 1, spread: true })
        about.getName(repo.feed, done())
        getMsg(repo.id, done())
        done(function (err, authorName, msg) {
          if (err) return cb(err)
          renderFeedItem(req, {
            key: repo.id,
            value: msg,
            authorName: authorName
          }, cb)
        })
      })
    ]))
  }

  function renderRepoUpdate(req, repo, msg, full) {
    var c = msg.value.content

    if (c.type != 'git-update') {
      return ''
      // return renderFeedItem(msg, cb)
      // TODO: render post, issue, pull-request
    }

    var refs = c.refs ? Object.keys(c.refs).map(function (ref) {
      return {name: ref, value: c.refs[ref]}
    }) : []
    var numObjects = c.objects ? Object.keys(c.objects).length : 0

    var dateStr = new Date(msg.value.timestamp).toLocaleString(req._locale)
    return '<section class="collapse">' +
      link([msg.key], dateStr) + '<br>' +
      (numObjects ? req._t('PushedObjects', numObjects) + '<br/>': '') +
      refs.map(function (update) {
        var name = escapeHTML(update.name)
        if (!update.value) {
          return req._t('DeletedBranch', {branch: name})
        } else {
          var commitLink = link([repo.id, 'commit', update.value])
          return name + ' &rarr; ' + commitLink
        }
      }).join('<br>') +
      '</section>'
  }

  /* Repo commits */

  function serveRepoCommits(req, repo, branch) {
    var query = req._u.query
    return renderRepoPage(req, repo, 'commits', branch, cat([
      pull.once('<h3>' + req._t('Commits') + '</h3>'),
      pull(
        repo.readLog(query.start || branch),
        pull.take(20),
        paramap(repo.getCommitParsed.bind(repo), 8),
        paginate(
          !query.start ? '' : function (first, cb) {
            cb(null, '&hellip;')
          },
          pull.map(renderCommit.bind(this, req, repo)),
          function (commit, cb) {
            cb(null, commit.parents && commit.parents[0] ?
              '<a href="?start=' + commit.id + '">' +
                req._t('Older') + '</a>' : '')
          }
        )
      )
    ]))
  }

  function renderCommit(req, repo, commit) {
    var commitPath = [repo.id, 'commit', commit.id]
    var treePath = [repo.id, 'tree', commit.id]
    return '<section class="collapse">' +
      '<strong>' + link(commitPath, commit.title) + '</strong><br>' +
      '<tt>' + commit.id + '</tt> ' +
        link(treePath, req._t('Tree')) + '<br>' +
      escapeHTML(commit.author.name) + ' &middot; ' +
      commit.author.date.toLocaleString(req._locale) +
      (commit.separateAuthor ? '<br>' + req._t('CommittedOn', {
        name: escapeHTML(commit.committer.name),
        date: commit.committer.date.toLocaleString(req._locale)
      }) : '') +
      '</section>'
  }

  /* Branch menu */

  function formatRevOptions(currentName) {
    return function (name) {
      var htmlName = escapeHTML(name)
      return '<option value="' + htmlName + '"' +
        (name == currentName ? ' selected="selected"' : '') +
        '>' + htmlName + '</option>'
    }
  }

  function formatRevType(req, type) {
    return (
      type == 'heads' ? req._t('Branches') :
      type == 'tags' ? req._t('Tags') :
      type)
  }

  function revMenu(req, repo, currentName) {
    return readOnce(function (cb) {
      repo.getRefNames(function (err, refs) {
        if (err) return cb(err)
        cb(null, '<select name="rev" onchange="this.form.submit()">' +
          Object.keys(refs).map(function (group) {
            return '<optgroup label="' + formatRevType(req, group) + '">' +
              refs[group].map(formatRevOptions(currentName)).join('') +
              '</optgroup>'
          }).join('') +
          '</select><noscript> ' +
          '<input type="submit" value="' + req._t('Go') + '"/></noscript>')
      })
    })
  }

  function branchMenu(repo, name, currentName) {
    return cat([
      pull.once('<select name="' + name + '">'),
      pull(
        repo.refs(),
        pull.map(function (ref) {
          var m = ref.name.match(/^refs\/([^\/]*)\/(.*)$/) || [,, ref.name]
          return m[1] == 'heads' && m[2]
        }),
        pull.filter(Boolean),
        pullSort(),
        pull.map(formatRevOptions(currentName))
      ),
      pull.once('</select>')
    ])
  }

  /* Repo tree */

  function renderRepoLatest(req, repo, rev) {
    return readOnce(function (cb) {
      repo.getCommitParsed(rev, function (err, commit) {
        if (err) return cb(err)
        var commitPath = [repo.id, 'commit', commit.id]
        cb(null,
          req._t('Latest') + ': ' +
          '<strong>' + link(commitPath, commit.title) + '</strong><br/>' +
          '<tt>' + commit.id + '</tt><br/> ' +
          req._t('CommittedOn', {
            name: escapeHTML(commit.committer.name),
            date: commit.committer.date.toLocaleString(req._locale)
          }) +
          (commit.separateAuthor ? '<br/>' + req._t('AuthoredOn', {
            name: escapeHTML(commit.author.name),
            date: commit.author.date.toLocaleString(req._locale)
          }) : ''))
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

  function renderRepoTree(req, repo, rev, path) {
    var pathLinks = path.length === 0 ? '' :
      ': ' + linkPath([repo.id, 'tree'], [rev].concat(path))
    return cat([
      pull.once('<h3>' + req._t('Files') + pathLinks + '</h3>'),
      pull(
        repo.readDir(rev, path),
        pull.map(function (file) {
          var type = (file.mode === 040000) ? 'tree' :
            (file.mode === 0160000) ? 'commit' : 'blob'
          if (type == 'commit')
            return [
              '<span title="' + req._t('gitCommitLink') + '">🖈</span>',
              '<span title="' + escapeHTML(file.id) + '">' +
                escapeHTML(file.name) + '</span>']
          var filePath = [repo.id, type, rev].concat(path, file.name)
          return ['<i>' + (type == 'tree' ? '📁' : '📄') + '</i>',
            link(filePath, file.name)]
        }),
        table('class="files"')
      )
    ])
  }

  /* Repo readme */

  function renderRepoReadme(req, repo, branch, path) {
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
            return cb(null, pull.once(path.length ? '' :
              '<p>' + req._t('NoReadme') + '</p>'))
          repo.getObjectFromAny(file.id, function (err, obj) {
            if (err) return cb(err)
            cb(null, cat([
              pull.once('<section><h4><a name="readme">' +
                escapeHTML(file.name) + '</a></h4><hr/>'),
              renderObjectData(obj, file.name, repo, branch, path),
              pull.once('</section>')
            ]))
          })
        })
      )
    })
  }

  /* Repo commit */

  function serveRepoCommit(req, repo, rev) {
    return renderRepoPage(req, repo, null, rev, cat([
      readNext(function (cb) {
        repo.getCommitParsed(rev, function (err, commit) {
          if (err) return cb(err)
          var commitPath = [repo.id, 'commit', commit.id]
          var treePath = [repo.id, 'tree', commit.id]
          cb(null, cat([pull.once(
            '<h3>' + link(commitPath,
              req._t('CommitRev', {rev: rev})) + '</h3>' +
            '<section class="collapse">' +
            '<div class="right-bar">' +
              link(treePath, req._t('BrowseFiles')) +
            '</div>' +
            '<h4>' + linkify(escapeHTML(commit.title)) + '</h4>' +
            (commit.body ? linkify(pre(commit.body)) : '') +
            (commit.separateAuthor ? req._t('AuthoredOn', {
              name: escapeHTML(commit.author.name),
              date: commit.author.date.toLocaleString(req._locale)
            }) + '<br/>' : '') +
            req._t('CommittedOn', {
              name: escapeHTML(commit.committer.name),
              date: commit.committer.date.toLocaleString(req._locale)
            }) + '<br/>' +
            commit.parents.map(function (id) {
              return req._t('Parent') + ': ' +
                link([repo.id, 'commit', id], id)
            }).join('<br>') +
            '</section>' +
            '<section><h3>' + req._t('FilesChanged') + '</h3>'),
            // TODO: show diff from all parents (merge commits)
            renderDiffStat(req, [repo, repo], [commit.parents[0], commit.id]),
            pull.once('</section>')
          ]))
        })
      })
    ]))
  }

  /* Diff stat */

  function renderDiffStat(req, repos, treeIds) {
    if (treeIds.length == 0) treeIds = [null]
    var id = treeIds[0]
    var lastI = treeIds.length - 1
    var oldTree = treeIds[0]
    var changedFiles = []
    return cat([
      pull(
        Repo.diffTrees(repos, treeIds, true),
        pull.map(function (item) {
          var filename = escapeHTML(item.filename = item.path.join('/'))
          var oldId = item.id && item.id[0]
          var newId = item.id && item.id[lastI]
          var oldMode = item.mode && item.mode[0]
          var newMode = item.mode && item.mode[lastI]
          var action =
            !oldId && newId ? req._t('action.added') :
            oldId && !newId ? req._t('action.deleted') :
            oldMode != newMode ? req._t('action.changedMode', {
              old: oldMode.toString(8),
              new: newMode.toString(8)
            }) : req._t('changed')
          if (item.id)
            changedFiles.push(item)
          var blobsPath = item.id[1]
            ? [repos[1].id, 'blob', treeIds[1]]
            : [repos[0].id, 'blob', treeIds[0]]
          var rawsPath = item.id[1]
            ? [repos[1].id, 'raw', treeIds[1]]
            : [repos[0].id, 'raw', treeIds[0]]
          item.blobPath = blobsPath.concat(item.path)
          item.rawPath = rawsPath.concat(item.path)
          var fileHref = item.id ?
            '#' + encodeURIComponent(item.path.join('/')) :
            encodeLink(item.blobPath)
          return ['<a href="' + fileHref + '">' + filename + '</a>', action]
        }),
        table()
      ),
      pull(
        pull.values(changedFiles),
        paramap(function (item, cb) {
          var extension = getExtension(item.filename)
          if (extension in imgMimes) {
            var filename = escapeHTML(item.filename)
            return cb(null,
              '<pre><table class="code">' +
              '<tr><th id="' + escapeHTML(item.filename) + '">' +
                filename + '</th></tr>' +
              '<tr><td><img src="' + encodeLink(item.rawPath) + '"' +
              ' alt="' + filename + '"/></td></tr>' +
              '</table></pre>')
          }
          var done = multicb({ pluck: 1, spread: true })
          getRepoObjectString(repos[0], item.id[0], done())
          getRepoObjectString(repos[1], item.id[lastI], done())
          done(function (err, strOld, strNew) {
            if (err) return cb(err)
            cb(null, htmlLineDiff(req, item.filename, item.filename,
              strOld, strNew,
              encodeLink(item.blobPath)))
          })
        }, 4)
      )
    ])
  }

  function htmlLineDiff(req, filename, anchor, oldStr, newStr, blobHref) {
    var diff = JsDiff.structuredPatch('', '', oldStr, newStr)
    var groups = diff.hunks.map(function (hunk) {
      var oldLine = hunk.oldStart
      var newLine = hunk.newStart
      var header = '<tr class="diff-hunk-header"><td colspan=2></td><td>' +
        '@@ -' + oldLine + ',' + hunk.oldLines + ' ' +
        '+' + newLine + ',' + hunk.newLines + ' @@' +
        '</td></tr>'
      return [header].concat(hunk.lines.map(function (line) {
        var s = line[0]
        if (s == '\\') return
        var html = highlight(line, getExtension(filename))
        var trClass = s == '+' ? 'diff-new' : s == '-' ? 'diff-old' : ''
        var lineNums = [s == '+' ? '' : oldLine++, s == '-' ? '' : newLine++]
        var id = [filename].concat(lineNums).join('-')
        return '<tr id="' + escapeHTML(id) + '" class="' + trClass + '">' +
          lineNums.map(function (num) {
            return '<td class="code-linenum">' +
              (num ? '<a href="#' + encodeURIComponent(id) + '">' +
                num + '</a>' : '') + '</td>'
          }).join('') +
          '<td class="code-text">' + html + '</td></tr>'
      }))
    })
    return '<pre><table class="code">' +
      '<tr><th colspan=3 id="' + escapeHTML(anchor) + '">' + filename +
      '<span class="right-bar">' +
        '<a href="' + blobHref + '">' + req._t('View') + '</a> ' +
      '</span></th></tr>' +
      [].concat.apply([], groups).join('') +
      '</table></pre>'
  }

  /* An unknown message linking to a repo */

  function serveRepoSomething(req, repo, id, msg, path) {
    return renderRepoPage(req, repo, null, null,
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

    if (raw)
      return renderRepoPage(req, repo, 'activity', null, pull.once(
        '<a href="?" class="raw-link header-align">' +
          req._t('Info') + '</a>' +
        '<h3>' + req._t('Update') + '</h3>' +
        '<section class="collapse">' +
          json({key: id, value: msg}) + '</section>'))

    // convert packs to old single-object style
    if (msg.content.indexes) {
      for (var i = 0; i < msg.content.indexes.length; i++) {
        msg.content.packs[i] = {
          pack: {link: msg.content.packs[i].link},
          idx: msg.content.indexes[i]
        }
      }
    }

    return renderRepoPage(req, repo, 'activity', null, cat([
      pull.values([
        '<a href="?raw" class="raw-link header-align">' +
          req._t('Data') + '</a>',
        '<h3>' + req._t('Update') + '</h3>',
        renderRepoUpdate(req, repo, {key: id, value: msg}, true)
      ].concat(msg.content.objects ?
        ['<h3>' + req._t('Objects') + '</h3>'].concat(
          objsArr(msg.content.objects).map(renderObject.bind(null, req)))
      : [],
      msg.content.packs ? [
        '<h3>' + req._t('Packs') + '</h3>'
      ].concat(msg.content.packs.map(renderPack.bind(null, req)))
      : [])),
      msg.content.packs && cat([
        pull.once('<h3>' + req._t('Commits') + '</h3>'),
        pull(
          pull.values(msg.content.packs),
          pull.asyncMap(function (pack, cb) {
            var done = multicb({ pluck: 1, spread: true })
            getBlob(req, pack.pack.link, done())
            getBlob(req, pack.idx.link, done())
            done(function (err, readPack, readIdx) {
              if (err) return cb(renderError(err))
              cb(null, gitPack.decodeWithIndex(repo, readPack, readIdx))
            })
          }),
          pull.flatten(),
          pull.asyncMap(function (obj, cb) {
            if (obj.type == 'commit')
              Repo.getCommitParsed(obj, cb)
            else
              pull(obj.read, pull.drain(null, cb))
          }),
          pull.filter(),
          pull.map(function (commit) {
            return renderCommit(req, repo, commit)
          })
        )
      ])
    ]))
  }

  function renderObject(req, obj) {
    return '<section class="collapse">' +
      obj.type + ' ' + link([obj.link], obj.sha1) + '<br>' +
      req._t('NumBytes', obj.length) +
      '</section>'
  }

  function renderPack(req, info) {
    return '<section class="collapse">' +
      (info.pack ? req._t('Pack') + ': ' +
        link([info.pack.link]) + '<br>' : '') +
      (info.idx ? req._t('Index') + ': ' +
        link([info.idx.link]) : '') + '</section>'
  }

  /* Blob */

  function serveRepoBlob(req, repo, rev, path) {
    return readNext(function (cb) {
      repo.getFile(rev, path, function (err, object) {
        if (err) return cb(null, serveBlobNotFound(req, repo.id, err))
        var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
        var pathLinks = path.length === 0 ? '' :
          ': ' + linkPath([repo.id, 'tree'], [rev].concat(path))
        var rawFilePath = [repo.id, 'raw', rev].concat(path)
        var dirPath = path.slice(0, path.length-1)
        var filename = path[path.length-1]
        var extension = getExtension(filename)
        cb(null, renderRepoPage(req, repo, 'code', rev, cat([
          pull.once('<section><form action="" method="get">' +
            '<h3>' + req._t(type) + ': ' + rev + ' '),
          revMenu(req, repo, rev),
          pull.once('</h3></form>'),
          type == 'Branch' && renderRepoLatest(req, repo, rev),
          pull.once('</section><section class="collapse">' +
            '<h3>' + req._t('Files') + pathLinks + '</h3>' +
            '<div>' + object.length + ' bytes' +
            '<span class="raw-link">' +
              link(rawFilePath, req._t('Raw')) + '</span>' +
            '</div></section>' +
            '<section>'),
          extension in imgMimes
          ? pull.once('<img src="' + encodeLink(rawFilePath) +
            '" alt="' + escapeHTML(filename) + '" />')
          : renderObjectData(object, filename, repo, rev, dirPath),
          pull.once('</section>')
        ])))
      })
    })
  }

  function serveBlobNotFound(req, repoId, err) {
    return serveTemplate(req, req._t('error.BlobNotFound'), 404)(pull.once(
      '<h2>' + req._t('error.BlobNotFound') + '</h2>' +
      '<p>' + req._t('error.BlobNotFoundInRepo', {
        repo: link([repoId])
      }) + '</p>' +
      '<pre>' + escapeHTML(err.stack) + '</pre>'
    ))
  }

  /* Raw blob */

  function serveRepoRaw(req, repo, branch, path) {
    return readNext(function (cb) {
      repo.getFile(branch, path, function (err, object) {
        if (err) return cb(null,
          serveBuffer(404, req._t('error.BlobNotFound')))
        var extension = getExtension(path[path.length-1])
        var contentType = imgMimes[extension]
        cb(null, pull(object.read, serveRaw(object.length, contentType)))
      })
    })
  }

  function serveRaw(length, contentType) {
    var headers = {
      'Content-Type': contentType || 'text/plain; charset=utf-8',
      'Cache-Control': 'max-age=31536000'
    }
    if (length != null)
      headers['Content-Length'] = length
    return function (read) {
      return cat([pull.once([200, headers]), read])
    }
  }

  function getBlob(req, key, cb) {
    ssb.blobs.want(key, function (err, got) {
      if (err) cb(err)
      else if (!got) cb(new Error(req._t('error.MissingBlob', {key: key})))
      else cb(null, ssb.blobs.get(key))
    })
  }

  function serveBlob(req, key) {
    return readNext(function (cb) {
      getBlob(req, key, function (err, read) {
        if (err) cb(null, serveError(req, err))
        else if (!read) cb(null, serve404(req))
        else cb(null, serveRaw()(read))
      })
    })
  }

  /* Digs */

  function serveRepoDigs(req, repo) {
    return readNext(function (cb) {
      getVotes(repo.id, function (err, votes) {
        cb(null, renderRepoPage(req, repo, null, null, cat([
          pull.once('<section><h3>' + req._t('Digs') + '</h3>' +
            '<div>' + req._t('Total') + ': ' + votes.upvotes + '</div>'),
          pull(
            pull.values(Object.keys(votes.upvoters)),
            paramap(function (feedId, cb) {
              about.getName(feedId, function (err, name) {
                if (err) return cb(err)
                cb(null, link([feedId], name))
              })
            }, 8),
            ul()
          ),
          pull.once('</section>')
        ])))
      })
    })
  }

  /* Forks */

  function getForks(repo, includeSelf) {
    return pull(
      cat([
        includeSelf && readOnce(function (cb) {
          getMsg(repo.id, function (err, value) {
            cb(err, value && {key: repo.id, value: value})
          })
        }),
        ssb.links({
          dest: repo.id,
          values: true,
          rel: 'upstream'
        })
      ]),
      pull.filter(function (msg) {
        return msg.value.content && msg.value.content.type == 'git-repo'
      }),
      paramap(function (msg, cb) {
        getRepoFullName(about, msg.value.author, msg.key,
            function (err, repoName, authorName) {
          if (err) return cb(err)
          cb(null, {
            key: msg.key,
            value: msg.value,
            repoName: repoName,
            authorName: authorName
          })
        })
      }, 8)
    )
  }

  function serveRepoForks(req, repo) {
    var hasForks
    return renderRepoPage(req, repo, null, null, cat([
      pull.once('<h3>' + req._t('Forks') + '</h3>'),
      pull(
        getForks(repo),
        pull.map(function (msg) {
          hasForks = true
          return '<section class="collapse">' +
            link([msg.value.author], msg.authorName) + ' / ' +
            link([msg.key], msg.repoName) +
            '<span class="right-bar">' +
            timestamp(msg.value.timestamp, req) +
            '</span></section>'
        })
      ),
      readOnce(function (cb) {
        cb(null, hasForks ? '' : req._t('NoForks'))
      })
    ]))
  }

  function serveRepoForkPrompt(req, repo) {
    return renderRepoPage(req, repo, null, null, pull.once(
      '<form action="" method="post" onreset="history.back()">' +
      '<h3>' + req._t('ForkRepoPrompt') + '</h3>' +
      '<p>' + hiddenInputs({ id: repo.id }) +
      '<button class="btn open" type="submit" name="action" value="fork">' +
        req._t('Fork') +
      '</button>' +
      ' <button class="btn" type="reset">' +
        req._t('Cancel') + '</button>' +
      '</p></form>'
    ))
  }

  /* Issues */

  function serveRepoIssues(req, repo, path) {
    var numIssues = 0
    var state = req._u.query.state || 'open'
    return renderRepoPage(req, repo, 'issues', null, cat([
      pull.once(
        (isPublic ? '' :
          '<form class="right-bar" method="get"' +
            ' action="' + encodeLink([repo.id, 'issues', 'new']) + '">' +
            '<button class="btn">&plus; ' + req._t('issue.New') + '</button>' +
          '</form>') +
        '<h3>' + req._t('Issues') + '</h3>' +
        nav([
          ['?', req._t('issues.Open'), 'open'],
          ['?state=closed', req._t('issues.Closed'), 'closed'],
          ['?state=all', req._t('issues.All'), 'all']
        ], state)),
      pull(
        issues.createFeedStream({ project: repo.id }),
        pull.filter(function (issue) {
          return state == 'all' ? true : (state == 'closed') == !issue.open
        }),
        pull.map(function (issue) {
          numIssues++
          var state = (issue.open ? 'open' : 'closed')
          var stateStr = req._t(issue.open ?
            'issue.state.Open' : 'issue.state.Closed')
          return '<section class="collapse">' +
            '<i class="issue-state issue-state-' + state + '"' +
              ' title="' + stateStr + '">◼</i> ' +
            '<a href="' + encodeLink(issue.id) + '">' +
              escapeHTML(issue.title) +
              '<span class="right-bar">' +
                new Date(issue.created_at).toLocaleString(req._locale) +
              '</span>' +
            '</a>' +
            '</section>'
        })
      ),
      readOnce(function (cb) {
        cb(null, numIssues > 0 ? '' : '<p>' + req._t('NoIssues') + '</p>')
      })
    ]))
  }

  /* Pull Requests */

  function serveRepoPullReqs(req, repo) {
    var count = 0
    var state = req._u.query.state || 'open'
    return renderRepoPage(req, repo, 'pulls', null, cat([
      pull.once(
        (isPublic ? '' :
          '<form class="right-bar" method="get"' +
            ' action="' + encodeLink([repo.id, 'compare']) + '">' +
            '<button class="btn">&plus; ' + req._t('pullRequest.New') +
            '</button>' +
          '</form>') +
        '<h3>' + req._t('PullRequests') + '</h3>' +
        nav([
          ['?', req._t('issues.Open'), 'open'],
          ['?state=closed', req._t('issues.Closed'), 'closed'],
          ['?state=all', req._t('issues.All'), 'all']
        ], state)),
      pull(
        pullReqs.list({
          repo: repo.id,
          open: {open: true, closed: false}[state]
        }),
        pull.map(function (issue) {
          count++
          var state = (issue.open ? 'open' : 'closed')
          var stateStr = req._t(issue.open ?
            'issue.state.Open' : 'issue.state.Closed')
          return '<section class="collapse">' +
            '<i class="issue-state issue-state-' + state + '"' +
              ' title="' + stateStr + '">◼</i> ' +
            '<a href="' + encodeLink(issue.id) + '">' +
              escapeHTML(issue.title) +
              '<span class="right-bar">' +
                new Date(issue.created_at).toLocaleString(req._locale) +
              '</span>' +
            '</a>' +
            '</section>'
        })
      ),
      readOnce(function (cb) {
        cb(null, count > 0 ? '' : '<p>' + req._t('NoPullRequests') + '</p>')
      })
    ]))
  }

  /* New Issue */

  function serveRepoNewIssue(req, repo, issueId, path) {
    return renderRepoPage(req, repo, 'issues', null, pull.once(
      '<h3>' + req._t('issue.New') + '</h3>' +
      '<section><form action="" method="post">' +
      '<input type="hidden" name="action" value="new-issue">' +
      '<p><input class="wide-input" name="title" placeholder="' +
        req._t('issue.Title') + '" size="77" /></p>' +
      renderPostForm(req, repo, req._t('Description'), 8) +
      '<button type="submit" class="btn">' + req._t('Create') + '</button>' +
      '</form></section>'))
  }

  /* Issue */

  function serveRepoIssue(req, repo, issue, path, postId) {
    var isAuthor = (myId == issue.author) || (myId == repo.feed)
    var newestMsg = {key: issue.id, value: {timestamp: issue.created_at}}
    return renderRepoPage(req, repo, 'issues', null, cat([
      pull.once(
        renderNameForm(req, !isPublic, issue.id, issue.title, 'issue-title',
          null, req._t('issue.Rename'),
          '<h3>' + link([issue.id], issue.title) + '</h3>') +
        '<code>' + issue.id + '</code>' +
        '<section class="collapse">' +
        (issue.open
          ? '<strong class="issue-status open">' +
            req._t('issue.state.Open') + '</strong>'
          : '<strong class="issue-status closed">' +
            req._t('issue.state.Closed') + '</strong>')),
      readOnce(function (cb) {
        about.getName(issue.author, function (err, authorName) {
          if (err) return cb(err)
          var authorLink = link([issue.author], authorName)
          cb(null, req._t('issue.Opened',
            {name: authorLink, datetime: timestamp(issue.created_at, req)}))
        })
      }),
      pull.once('<hr/>' + markdown(issue.text, repo) + '</section>'),
      // render posts and edits
      pull(
        ssb.links({
          dest: issue.id,
          values: true
        }),
        pull.unique('key'),
        addAuthorName(about),
        sortMsgs(),
        pull.through(function (msg) {
          if (msg.value.timestamp > newestMsg.value.timestamp)
            newestMsg = msg
        }),
        pull.map(renderIssueActivityMsg.bind(null, req, repo, issue,
          req._t('issue.'), postId))
      ),
      isPublic ? pull.empty() : readOnce(function (cb) {
        cb(null, renderIssueCommentForm(req, issue, repo, newestMsg.key,
          isAuthor, req._t('issue.')))
      })
    ]))
  }

  function renderIssueActivityMsg(req, repo, issue, type, postId, msg) {
    var authorLink = link([msg.value.author], msg.authorName)
    var msgHref = encodeLink(msg.key) + '#' + encodeURIComponent(msg.key)
    var msgTimeLink = '<a href="' + msgHref + '"' +
      ' name="' + escapeHTML(msg.key) + '">' +
      new Date(msg.value.timestamp).toLocaleString(req._locale) + '</a>'
    var c = msg.value.content
    switch (c.type) {
      case 'post':
        if (c.root == issue.id) {
          var changed = issues.isStatusChanged(msg, issue)
          return '<section class="collapse">' +
            (msg.key == postId ? '<div class="highlight">' : '') +
            '<tt class="right-bar item-id">' + msg.key + '</tt> ' +
            (changed == null ? authorLink : req._t(
              changed ? 'issue.Reopened' : 'issue.Closed',
              {name: authorLink, type: type})) +
            ' &middot; ' + msgTimeLink +
            (msg.key == postId ? '</div>' : '') +
            markdown(c.text, repo) +
            '</section>'
        } else {
          var text = c.text || (c.type + ' ' + msg.key)
          return '<section class="collapse mention-preview">' +
            req._t('issue.MentionedIn', {
              name: authorLink,
              type: type,
              post: '<a href="/' + msg.key + '#' + msg.key + '">' +
                String(text).substr(0, 140) + '</a>'
            }) + '</section>'
        }
      case 'issue':
      case 'pull-request':
        return '<section class="collapse mention-preview">' +
          req._t('issue.MentionedIn', {
            name: authorLink,
            type: type,
            post: link([msg.key], String(c.title || msg.key).substr(0, 140))
          }) + '</section>'
      case 'issue-edit':
        return '<section class="collapse">' +
          (msg.key == postId ? '<div class="highlight">' : '') +
          (c.title == null ? '' : req._t('issue.Renamed', {
            name: authorLink,
            type: type,
            name: '<q>' + escapeHTML(c.title) + '</q>'
          })) + ' &middot; ' + msgTimeLink +
          (msg.key == postId ? '</div>' : '') +
          '</section>'
      case 'git-update':
        var mention = issues.getMention(msg, issue)
        if (mention) {
          var commitLink = link([repo.id, 'commit', mention.object],
            mention.label || mention.object)
          return '<section class="collapse">' +
            req._t(mention.open ? 'issue.Reopened' : 'issue.Closed', {
              name: authorLink,
              type: type
            }) + ' &middot; ' + msgTimeLink + '<br/>' +
            commitLink +
            '</section>'
        } else if ((mention = getMention(msg, issue.id))) {
          var commitLink = link(mention.object ?
            [repo.id, 'commit', mention.object] : [msg.key],
            mention.label || mention.object || msg.key)
          return '<section class="collapse">' +
            req._t('issue.Mentioned', {
              name: authorLink,
              type: type
            }) + ' &middot; ' + msgTimeLink + '<br/>' +
            commitLink +
            '</section>'
        } else {
          // fallthrough
        }

      default:
        return '<section class="collapse">' +
          authorLink +
          ' &middot; ' + msgTimeLink +
          json(c) +
          '</section>'
    }
  }

  function renderIssueCommentForm(req, issue, repo, branch, isAuthor, type) {
    return '<section><form action="" method="post">' +
      '<input type="hidden" name="action" value="comment">' +
      '<input type="hidden" name="id" value="' + issue.id + '">' +
      '<input type="hidden" name="issue" value="' + issue.id + '">' +
      '<input type="hidden" name="repo" value="' + repo.id + '">' +
      '<input type="hidden" name="branch" value="' + branch + '">' +
      renderPostForm(req, repo) +
      '<input type="submit" class="btn open" value="' +
        req._t('issue.Comment') + '" />' +
      (isAuthor ?
        '<input type="submit" class="btn"' +
        ' name="' + (issue.open ? 'close' : 'open') + '"' +
        ' value="' + req._t(
          issue.open ? 'issue.Close' : 'issue.Reopen', {type: type}
        ) + '"/>' : '') +
      '</form></section>'
  }

  /* Pull Request */

  function serveRepoPullReq(req, repo, pr, path, postId) {
    var headRepo, authorLink
    var page = path[0] || 'activity'
    return renderRepoPage(req, repo, 'pulls', null, cat([
      pull.once('<div class="pull-request">' +
        renderNameForm(req, !isPublic, pr.id, pr.title, 'issue-title', null,
          req._t('pullRequest.Rename'),
          '<h3>' + link([pr.id], pr.title) + '</h3>') +
        '<code>' + pr.id + '</code>'),
      readOnce(function (cb) {
        var done = multicb({ pluck: 1, spread: true })
        var gotHeadRepo = done()
        about.getName(pr.author, done())
        var sameRepo = (pr.headRepo == pr.baseRepo)
        getRepo(pr.headRepo, function (err, headRepo) {
          if (err) return cb(err)
          getRepoName(about, headRepo.feed, headRepo.id, done())
          about.getName(headRepo.feed, done())
          gotHeadRepo(null, Repo(headRepo))
        })

        done(function (err, _headRepo, issueAuthorName,
            headRepoName, headRepoAuthorName) {
          if (err) return cb(err)
          headRepo = _headRepo
          authorLink = link([pr.author], issueAuthorName)
          var repoLink = link([pr.headRepo], headRepoName)
          var headRepoAuthorLink = link([headRepo.feed], headRepoAuthorName)
          var headRepoLink = link([headRepo.id], headRepoName)
          var headBranchLink = link([headRepo.id, 'tree', pr.headBranch])
          var baseBranchLink = link([repo.id, 'tree', pr.baseBranch])
          cb(null, '<section class="collapse">' +
            '<strong class="issue-status ' +
            (pr.open ? 'open' : 'closed') + '">' +
            req._t(pr.open ? 'issue.state.Open' : 'issue.state.Closed') +
            '</strong> ' +
            req._t('pullRequest.WantToMerge', {
              name: authorLink,
              base: '<code>' + baseBranchLink + '</code>',
              head: (sameRepo ?
                '<code>' + headBranchLink + '</code>' :
                '<code class="bgslash">' +
                  headRepoAuthorLink + ' / ' +
                  headRepoLink + ' / ' +
                  headBranchLink + '</code>')
            }) + '</section>')
        })
      }),
      pull.once(
        nav([
          [[pr.id], req._t('Discussion'), 'activity'],
          [[pr.id, 'commits'], req._t('Commits'), 'commits'],
          [[pr.id, 'files'], req._t('Files'), 'files']
        ], page)),
      readNext(function (cb) {
        if (page == 'commits') cb(null,
          renderPullReqCommits(req, pr, repo, headRepo))
        else if (page == 'files') cb(null,
          renderPullReqFiles(req, pr, repo, headRepo))
        else cb(null,
          renderPullReqActivity(req, pr, repo, headRepo, authorLink, postId))
      })
    ]))
  }

  function renderPullReqCommits(req, pr, baseRepo, headRepo) {
    return cat([
      pull.once('<section>'),
      renderCommitLog(req, baseRepo, pr.baseBranch, headRepo, pr.headBranch),
      pull.once('</section>')
    ])
  }

  function renderPullReqFiles(req, pr, baseRepo, headRepo) {
    return cat([
      pull.once('<section>'),
      renderDiffStat(req,
        [baseRepo, headRepo], [pr.baseBranch, pr.headBranch]),
      pull.once('</section>')
    ])
  }

  function renderPullReqActivity(req, pr, repo, headRepo, authorLink, postId) {
    var msgTimeLink = link([pr.id],
      new Date(pr.created_at).toLocaleString(req._locale))
    var newestMsg = {key: pr.id, value: {timestamp: pr.created_at}}
    var isAuthor = (myId == pr.author) || (myId == repo.feed)
    return cat([
      readOnce(function (cb) {
        cb(null,
          '<section class="collapse">' +
            authorLink + ' &middot; ' + msgTimeLink +
            markdown(pr.text, repo) + '</section>')
      }),
      // render posts, edits, and updates
      pull(
        many([
          ssb.links({
            dest: pr.id,
            values: true
          }),
          readNext(function (cb) {
            cb(null, pull(
              ssb.links({
                dest: headRepo.id,
                source: headRepo.feed,
                rel: 'repo',
                values: true,
                reverse: true
              }),
              pull.take(function (link) {
                return link.value.timestamp > pr.created_at
              }),
              pull.filter(function (link) {
                return link.value.content.type == 'git-update'
                  && ('refs/heads/' + pr.headBranch) in link.value.content.refs
              })
            ))
          })
        ]),
        addAuthorName(about),
        pull.unique('key'),
        pull.through(function (msg) {
          if (msg.value.timestamp > newestMsg.value.timestamp)
            newestMsg = msg
        }),
        sortMsgs(),
        pull.map(function (item) {
          if (item.value.content.type == 'git-update')
            return renderBranchUpdate(req, pr, item)
          return renderIssueActivityMsg(req, repo, pr,
            req._t('pull request'), postId, item)
        })
      ),
      !isPublic && isAuthor && pr.open && pull.once(
        '<section class="merge-instructions">' +
        '<input type="checkbox" class="toggle" id="merge-instructions"/>' +
        '<h4><label for="merge-instructions" class="toggle-link"><a>' +
        req._t('mergeInstructions.MergeViaCmdLine') +
        '</a></label></h4>' +
        '<div class="contents">' +
        '<p>' + req._t('mergeInstructions.CheckOut') + '</p>' +
        '<pre>' +
        'git fetch ssb://' + escapeHTML(pr.headRepo) + ' ' +
          escapeHTML(pr.headBranch) + '\n' +
        'git checkout -b ' + escapeHTML(pr.headBranch) + ' FETCH_HEAD' +
        '</pre>' +
        '<p>' + req._t('mergeInstructions.MergeAndPush') + '</p>' +
        '<pre>' +
        'git checkout ' + escapeHTML(pr.baseBranch) + '\n' +
        'git merge ' + escapeHTML(pr.headBranch) + '\n' +
        'git push ssb ' + escapeHTML(pr.baseBranch) +
        '</pre>' +
        '</div></section>'),
      !isPublic && readOnce(function (cb) {
        cb(null, renderIssueCommentForm(req, pr, repo, newestMsg.key, isAuthor,
          req._t('pull request')))
      })
    ])
  }

  function renderBranchUpdate(req, pr, msg) {
    var authorLink = link([msg.value.author], msg.authorName)
    var msgLink = link([msg.key],
      new Date(msg.value.timestamp).toLocaleString(req._locale))
    var rev = msg.value.content.refs['refs/heads/' + pr.headBranch]
    if (!rev)
      return '<section class="collapse">' +
        req._t('NameDeletedBranch', {
          name: authorLink,
          branch: '<code>' + pr.headBranch + '</code>'
        }) + ' &middot; ' + msgLink +
        '</section>'

    var revLink = link([pr.headRepo, 'commit', rev], rev.substr(0, 8))
    return '<section class="collapse">' +
      req._t('NameUpdatedBranch', {
        name: authorLink,
        rev: '<code>' + revLink + '</code>'
      }) + ' &middot; ' + msgLink +
      '</section>'
  }

  /* Compare changes */

  function serveRepoCompare(req, repo) {
    var query = req._u.query
    var base
    var count = 0

    return renderRepoPage(req, repo, 'pulls', null, cat([
      pull.once('<h3>' + req._t('CompareChanges') + '</h3>' +
        '<form action="' + encodeLink(repo.id) + '/comparing" method="get">' +
        '<section>'),
      pull.once(req._t('BaseBranch') + ': '),
      readNext(function (cb) {
        if (query.base) gotBase(null, query.base)
        else repo.getSymRef('HEAD', true, gotBase)
        function gotBase(err, ref) {
          if (err) return cb(err)
          cb(null, branchMenu(repo, 'base', base = ref || 'HEAD'))
        }
      }),
      pull.once('<br/>' + req._t('ComparisonRepoBranch') + ':'),
      pull(
        getForks(repo, true),
        pull.asyncMap(function (msg, cb) {
          getRepo(msg.key, function (err, repo) {
            if (err) return cb(err)
            cb(null, {
              msg: msg,
              repo: repo
            })
          })
        }),
        pull.map(renderFork),
        pull.flatten()
      ),
      pull.once('</section>'),
      readOnce(function (cb) {
        cb(null, count == 0 ? req._t('NoBranches') :
          '<button type="submit" class="btn">' +
          req._t('Compare') + '</button>')
      }),
      pull.once('</form>')
    ]))

    function renderFork(fork) {
      return pull(
        fork.repo.refs(),
        pull.map(function (ref) {
          var m = /^refs\/([^\/]*)\/(.*)$/.exec(ref.name) || [,ref.name]
          return {
            type: m[1],
            name: m[2],
            value: ref.value
          }
        }),
        pull.filter(function (ref) {
          return ref.type == 'heads'
            && !(ref.name == base && fork.msg.key == repo.id)
        }),
        pull.map(function (ref) {
          var branchLink = link([fork.msg.key, 'tree', ref.name], ref.name)
          var authorLink = link([fork.msg.value.author], fork.msg.authorName)
          var repoLink = link([fork.msg.key], fork.msg.repoName)
          var value = fork.msg.key + ':' + ref.name
          count++
          return '<div class="bgslash">' +
            '<input type="radio" name="head"' +
            ' value="' + escapeHTML(value) + '"' +
            (query.head == value ? ' checked="checked"' : '') + '> ' +
            authorLink + ' / ' + repoLink + ' / ' + branchLink + '</div>'
        })
      )
    }
  }

  function serveRepoComparing(req, repo) {
    var query = req._u.query
    var baseBranch = query.base
    var s = (query.head || '').split(':')

    if (!s || !baseBranch)
      return serveRedirect(req, encodeLink([repo.id, 'compare']))

    var headRepoId = s[0]
    var headBranch = s[1]
    var baseLink = link([repo.id, 'tree', baseBranch])
    var headBranchLink = link([headRepoId, 'tree', headBranch])
    var backHref = encodeLink([repo.id, 'compare']) + req._u.search

    return renderRepoPage(req, repo, 'pulls', null, cat([
      pull.once('<h3>' +
      req._t(query.expand ? 'OpenPullRequest': 'ComparingChanges') +
      '</h3>'),
      readNext(function (cb) {
        getRepo(headRepoId, function (err, headRepo) {
          if (err) return cb(err)
          getRepoFullName(about, headRepo.feed, headRepo.id,
            function (err, repoName, authorName) {
              if (err) return cb(err)
              cb(null, renderRepoInfo(Repo(headRepo), repoName, authorName))
            }
          )
        })
      })
    ]))

    function renderRepoInfo(headRepo, headRepoName, headRepoAuthorName) {
      var authorLink = link([headRepo.feed], headRepoAuthorName)
      var repoLink = link([headRepoId], headRepoName)
      return cat([
        pull.once('<section>' +
          req._t('Base') + ': ' + baseLink + '<br/>' +
          req._t('Head') + ': ' +
          '<span class="bgslash">' + authorLink + ' / ' + repoLink +
          ' / ' + headBranchLink + '</span>' +
          '</section>' +
          (query.expand ? '<section><form method="post" action="">' +
            hiddenInputs({
              action: 'new-pull',
              branch: baseBranch,
              head_repo: headRepoId,
              head_branch: headBranch
            }) +
            '<input class="wide-input" name="title"' +
            ' placeholder="' + req._t('Title') + '" size="77"/>' +
            renderPostForm(req, repo, req._t('Description'), 8) +
            '<button type="submit" class="btn open">' +
              req._t('Create') + '</button>' +
            '</form></section>'
          : '<section><form method="get" action="">' +
            hiddenInputs({
              base: baseBranch,
              head: query.head
            }) +
            '<button class="btn open" type="submit" name="expand" value="1">' +
              '<i>⎇</i> ' + req._t('CreatePullRequest') + '</button> ' +
            '<a href="' + backHref + '">' + req._t('Back') + '</a>' +
            '</form></section>') +
          '<div id="commits"></div>' +
          '<div class="tab-links">' +
            '<a href="#" id="files-link">' + req._t('FilesChanged') + '</a> ' +
            '<a href="#commits" id="commits-link">' +
              req._t('Commits') + '</a>' +
          '</div>' +
          '<section id="files-tab">'),
        renderDiffStat(req, [repo, headRepo], [baseBranch, headBranch]),
        pull.once('</section>' +
          '<section id="commits-tab">'),
        renderCommitLog(req, repo, baseBranch, headRepo, headBranch),
        pull.once('</section>')
      ])
    }
  }

  function renderCommitLog(req, baseRepo, baseBranch, headRepo, headBranch) {
    return cat([
      pull.once('<table class="compare-commits">'),
      readNext(function (cb) {
        baseRepo.resolveRef(baseBranch, function (err, baseBranchRev) {
          if (err) return cb(err)
          var currentDay
          return cb(null, pull(
            headRepo.readLog(headBranch),
            pull.take(function (rev) { return rev != baseBranchRev }),
            pullReverse(),
            paramap(headRepo.getCommitParsed.bind(headRepo), 8),
            pull.map(function (commit) {
              var commitPath = [headRepo.id, 'commit', commit.id]
              var commitIdShort = '<tt>' + commit.id.substr(0, 8) + '</tt>'
              var day = Math.floor(commit.author.date / 86400000)
              var dateRow = day == currentDay ? '' :
                '<tr><th colspan=3 class="date-info">' +
                commit.author.date.toLocaleDateString(req._locale) +
                '</th><tr>'
              currentDay = day
              return dateRow + '<tr>' +
                '<td>' + escapeHTML(commit.author.name) + '</td>' +
                '<td>' + link(commitPath, commit.title) + '</td>' +
                '<td>' + link(commitPath, commitIdShort, true) + '</td>' +
                '</tr>'
            })
          ))
        })
      }),
      pull.once('</table>')
    ])
  }
}
