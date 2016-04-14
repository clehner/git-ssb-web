var Polyglot = require('node-polyglot')
var path = require('path')
var fs = require('fs')
var asyncMemo = require('asyncmemo')

var i18n = module.exports = {
  dir: path.join(__dirname, 'locale'),
  fallback: 'en',

  getCatalog: asyncMemo(function (locale, cb) {
    if (!locale) return cb()
    var filename = path.join(i18n.dir, locale.replace(/\//g, '') + '.json')
    fs.access(filename, fs.R_OK, function (err) {
      if (err) return cb()
      fs.readFile(filename, onRead)
    })
    function onRead(err, data) {
      if (err) return cb(err)
      var phrases
      try { phrases = JSON.parse(data) }
      catch(e) { return cb(e) }
      var polyglot = new Polyglot({locale: locale, phrases: phrases})
      var t = polyglot.t.bind(polyglot)
      t.locale = polyglot.currentLocale
      cb(null, t)
    }
  }),

  pickCatalog: function (acceptLocales, locale, cb) {
    i18n.getCatalog(locale, function (err, phrases) {
      if (err || phrases) return cb(err, phrases)
      var locales = String(acceptLocales).split(/, */).map(function (item) {
        return item.split(';')[0]
      })
      i18n.pickCatalog2(locales.concat(
        process.env.LANG && process.env.LANG.replace(/[._].*/, ''),
        i18n.fallback
      ).reverse(), cb)
    })
  },

  pickCatalog2: function (locales, cb) {
    if (!locales.length) return cb(null, new Error('No locale'))
    i18n.getCatalog(locales.pop(), function (err, phrases) {
      if (err || phrases) return cb(err, phrases)
      i18n.pickCatalog2(locales, cb)
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
