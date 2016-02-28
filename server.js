#!/bin/sh
':' //; exec "$(command -v nodejs || command -v node)" "$0" "$@"
// http://unix.stackexchange.com/questions/65235/universal-node-js-shebang
// vi: ft=javascript

var appName = process.env.ssb_appname ||
  require('child_process').spawnSync('git', ['config', 'ssb.appname'],
    {encoding: 'utf8'}).stdout.trim()
var ssbConfig = require('ssb-config/inject')(appName)
var ssbClient = require('ssb-client')
var keys = require('ssb-keys')
  .loadOrCreateSync(require('path').join(ssbConfig.path, 'secret'))

require('.')(process.argv[3], function (err, server) {
  require('ssb-reconnect')(function (cb) {
    ssbClient(keys, ssbConfig, cb)
  }, function (err, ssb, reconnect) {
    if (err) throw err
    server.setSSB(ssb, reconnect)
  })
})
