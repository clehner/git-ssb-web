/* ssb-about
 * factored out of ssb-notifier
 *
 * TODO:
 * - publish as own module
 * - handle live updates and reconnecting
 * - deprecate when ssb-names is used in scuttlebot
 */

var pull = require('pull-stream')
var cat = require('pull-cat')
var asyncMemo = require('asyncmemo')

module.exports = function (sbot, id) {
  var getAbout = asyncMemo(getAboutFull, sbot, id)

  getAbout.getName = function (id, cb) {
    getAbout(id, function (err, about) {
      cb(err, about && about.name)
    })
  }

  getAbout.getImage = function (id, cb) {
    getAbout(id, function (err, about) {
      cb(err, about && about.image)
    })
  }

  return getAbout
}

function truncate(str, len) {
  str = String(str)
  return str.length < len ? str : str.substr(0, len-1) + '…'
}

// Get About info (name and icon) for a feed.
function getAboutFull(sbot, source, dest, cb) {
  var info = {}
  var target = dest.target || dest
  var owner = dest.owner || dest

  pull(
    cat([
      // First get About info that we gave them.
      sbot.links({
        source: source,
        dest: target,
        rel: 'about',
        values: true,
        reverse: true
      }),
      // If that isn't enough, then get About info that they gave themselves.
      sbot.links({
        source: owner,
        dest: target,
        rel: 'about',
        values: true,
        reverse: true
      }),
    ]),
    pull.filter(function (msg) {
      return msg && msg.value.content
    }),
    pull.drain(function (msg) {
      if (info.name && info.image) return false
      var c = msg.value.content
      if (!info.name && c.name)
        info.name = c.name
      if (!info.image && c.image)
        info.image = c.image.link
    }, function (err) {
        if (err && err !== true) return cb(err)
        if (!info.name) info.name = truncate(target, 20)
        cb(null, info)
    })
  )

  // Keep updated as changes are made
  pull(
    sbot.links({
      dest: target,
      rel: 'about',
      live: true,
      values: true,
      gte: Date.now()
    }),
    pull.drain(function (msg) {
      var c = msg.value.content
      if (msg.value.author == source || msg.value.author == owner) {
        // TODO: give about from source (self) priority over about from owner
        if (c.name)
          info.name = c.name
        if (c.image)
          info.image = c.image
      }
    }, function (err) {
      if (err) console.error(err)
    })
  )
}
