#!/bin/sh
':' //; exec "$(command -v node || command -v nodejs)" "$0" "$@"
// http://unix.stackexchange.com/questions/65235/universal-node-js-shebang
// vi: ft=javascript

var appName = 'ssb_appname' in process.env ? process.env.ssb_appname :
  require('child_process').spawnSync('git', ['config', 'ssb.appname'],
    {encoding: 'utf8'}).stdout.trim()
var config = require('ssb-config/inject')(appName)
var ssbClient = require('ssb-client')
var keys = require('ssb-keys')
  .loadOrCreateSync(require('path').join(config.path, 'secret'))
var Web = require('.')

config.listenAddr = config._[1]
config.appname = appName

require('ssb-reconnect')(function (cb) {
  ssbClient(keys, config, cb)
}, function (err, ssb, reconnect) {
  if (err) throw err
  Web.init(ssb, config, reconnect)
})
