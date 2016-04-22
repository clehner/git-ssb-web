var pull = require('pull-stream')
var Highlight = require('highlight.js')
var u = exports

u.imgMimes = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  svg: 'image/svg+xml',
  bmp: 'image/bmp'
}

u.getExtension = function(filename) {
  return (/\.([^.]+)$/.exec(filename) || [,filename])[1]
}

u.readNext = function (fn) {
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

u.readOnce = function (fn) {
  var ended
  return function (end, cb) {
    fn(function (err, data) {
      if (err || ended) return cb(err || ended)
      ended = true
      cb(null, data)
    })
  }
}

u.escape = function (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

u.encodeLink = function (url) {
  if (!Array.isArray(url)) url = [url]
  return '/' + url.map(encodeURIComponent).join('/')
}

u.link = function (parts, text, raw, props) {
  if (text == null) text = parts[parts.length-1]
  if (!raw) text = u.escape(text)
  return '<a href="' + u.encodeLink(parts) + '"' +
    (props ? ' ' + props : '') +
    '>' + text + '</a>'
}

u.timestamp = function (time, req) {
  time = Number(time)
  var d = new Date(time)
  return '<span title="' + time + '">' +
    d.toLocaleString(req._locale) + '</span>'
}

u.nav = function (links, page, after) {
  return ['<nav>'].concat(
    links.map(function (link) {
      var href = typeof link[0] == 'string' ? link[0] : u.encodeLink(link[0])
      var props = link[2] == page ? ' class="active"' : ''
      return '<a href="' + href + '"' + props + '>' + link[1] + '</a>'
    }), after || '', '</nav>').join('')
}

u.highlight = function(code, lang) {
  try {
    return lang
      ? Highlight.highlight(lang, code).value
      : Highlight.highlightAuto(code).value
  } catch(e) {
    if (/^Unknown language/.test(e.message))
      return u.escape(code)
    throw e
  }
}

u.pre = function (text) {
  return '<pre>' + u.escape(text) + '</pre>'
}

u.json = function (obj) {
  return linkify(u.pre(JSON.stringify(obj, null, 2)))
}

u.linkify = function (text) {
  // regex is from ssb-ref
  return text.replace(/(@|%|&|&amp;)[A-Za-z0-9\/+]{43}=\.[\w\d]+/g, function (str) {
    return '<a href="/' + encodeURIComponent(str) + '">' + str + '</a>'
  })
}

u.readObjectString = function (obj, cb) {
  pull(obj.read, pull.collect(function (err, bufs) {
    if (err) return cb(err)
    cb(null, Buffer.concat(bufs, obj.length).toString('utf8'))
  }))
}

u.pullReverse = function () {
  return function (read) {
    return u.readNext(function (cb) {
      pull(read, pull.collect(function (err, items) {
        cb(err, items && pull.values(items.reverse()))
      }))
    })
  }
}

function compareMsgs(a, b) {
  return (a.value.timestamp - b.value.timestamp) || (a.key - b.key)
}

u.pullSort = function (comparator) {
  return function (read) {
    return u.readNext(function (cb) {
      pull(read, pull.collect(function (err, items) {
        if (err) return cb(err)
        items.sort(comparator)
        cb(null, pull.values(items))
      }))
    })
  }
}

u.sortMsgs = function () {
  return u.pullSort(compareMsgs)
}
