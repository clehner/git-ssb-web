#!/bin/sh
':' //; exec "$(command -v nodejs || command -v node)" "$0" "$@"
// http://unix.stackexchange.com/questions/65235/universal-node-js-shebang
// vi: ft=javascript

var appName = process.env.ssb_appname ||
  require('child_process').spawnSync('git', ['config', 'ssb.appname'],
    {encoding: 'utf8'}).stdout.trim()
var config = require('ssb-config/inject')(appName)
var ssbClient = require('ssb-client')
var keys = require('ssb-keys')
  .loadOrCreateSync(require('path').join(config.path, 'secret'))

var opts = config
opts.listenAddr = opts._[1]
opts.appname = appName

require('.')(opts, function (err, server) {
  require('ssb-reconnect')(function (cb) {
    ssbClient(keys, config, cb)
  }, function (err, ssb, reconnect) {
    if (err) throw err
    server.setSSB(ssb, reconnect)
  })
})
