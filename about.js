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

module.exports = function (sbot, myId) {
  var cache = {/* id: about */}
  var callbacks = {/* id: [callback] */}

  function getAbout(id, cb) {
    if (id in cache)
      return cb(null, cache[id])
    if (id in callbacks)
      return callbacks[id].push(cb)
    var cbs = callbacks[id] = [cb]
    getAboutFull(sbot, myId, id, function (err, about) {
      var about = !err && (cache[id] = about)
      while (cbs.length)
        cbs.pop()(err, about)
    })
  }

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
  var name, image
  pull(
    cat([
      // First get About info that we gave them.
      sbot.links({
        source: source,
        dest: dest,
        rel: 'about',
        values: true,
        reverse: true
      }),
      // If that isn't enough, then get About info that they gave themselves.
      sbot.links({
        source: dest,
        dest: dest,
        rel: 'about',
        values: true,
        reverse: true
      }),
    ]),
    pull.filter(function (msg) {
      return msg && msg.value.content && (!name || !image)
    }),
    pull.drain(function (msg) {
      var c = msg.value.content
      if (!name) {
        name = c.name
      }
      if (!image) {
        image = c.image ? c.image.link : c.image
        // var imgLink = mlib.link(c.image, 'blob')
        // image = imgLink && imgLink.link
      }
    }, function (err) {
      if (err) return cb(err)
      cb(null, {name: name || truncate(id, 8), image: image})
    })
  )
}
