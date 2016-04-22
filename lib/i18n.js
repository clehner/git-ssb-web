var Polyglot = require('node-polyglot')
var path = require('path')
var fs = require('fs')
var asyncMemo = require('asyncmemo')

module.exports = function (localesDir, fallback) {
  return new I18n(localesDir, fallback)
}

function I18n(dir, fallback) {
  this.dir = dir
  this.fallback = fallback
}

I18n.prototype = {
  constructor: I18n,

  getCatalog: asyncMemo(function (locale, cb) {
    var self = this
    if (!locale) return cb.call(self)
    var filename = path.join(this.dir, locale.replace(/\//g, '') + '.json')
    fs.access(filename, fs.R_OK, function (err) {
      if (err) return cb.call(self)
      fs.readFile(filename, onRead)
    })
    function onRead(err, data) {
      if (err) return cb.call(self, err)
      var phrases
      try { phrases = JSON.parse(data) }
      catch(e) { return cb.call(self, e) }
      var polyglot = new Polyglot({locale: locale, phrases: phrases})
      var t = polyglot.t.bind(polyglot)
      t.locale = polyglot.currentLocale
      cb.call(self, null, t)
    }
  }),

  pickCatalog: function (acceptLocales, locale, cb) {
    this.getCatalog(locale, function (err, phrases) {
      if (err || phrases) return cb(err, phrases)
      var locales = String(acceptLocales).split(/, */).map(function (item) {
        return item.split(';')[0]
      })
      this.pickCatalog2(locales.concat(
        process.env.LANG && process.env.LANG.replace(/[._].*/, ''),
        this.fallback
      ).reverse(), cb)
    })
  },

  pickCatalog2: function (locales, cb) {
    if (!locales.length) return cb(null, new Error('No locale'))
    this.getCatalog(locales.pop(), function (err, phrases) {
      if (err || phrases) return cb(err, phrases)
      this.pickCatalog2(locales, cb)
    })
  },

  listLocales: function (cb) {
    fs.readdir(dir, function (err, files) {
      if (err) return cb(err)
      cb(null, files.map(function (filename) {
        return filename.replace(/\.json$/, '')
      }))
    })
  }
}
