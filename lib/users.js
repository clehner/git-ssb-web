var pull = require('pull-stream')
var cat = require('pull-cat')
var paramap = require('pull-paramap')
var multicb = require('multicb')
var u = require('./util')

module.exports = function (web) {
  return new UserRoutes(web)
}

function UserRoutes(web) {
  this.web = web
}

var U = UserRoutes.prototype

U.serveUserPage = function (req, feedId, dirs) {
  switch (dirs[0]) {
    case undefined:
    case '':
    case 'activity':
      return this.serveUserActivity(req, feedId)
    case 'repos':
      return this.serveUserRepos(req, feedId)
    case 'digs':
      return this.serveUserDigs(req, feedId)
  }
}

U.renderUserPage = function (req, feedId, page, titleTemplate, body) {
  var self = this
  return u.readNext(function (cb) {
    self.web.about(feedId, function (err, about) {
      if (err) return cb(err)
      var title = titleTemplate ? titleTemplate
        .replace(/\%{name\}/g, u.escape(about.name))
        : u.escape(about.name)
      cb(null, self.web.serveTemplate(req, title)(cat([
        pull.once('<h2>' + u.link([feedId], (about.image ?
          '<img class="profile-icon"' +
          ' src="/' + encodeURIComponent(about.image) + '"' +
          ' alt="' + u.escape(about.name) + '"> ' : '') +
          u.escape(about.name), true) +
        '<code class="user-id">' + feedId + '</code></h2>' +
        u.nav([
          [[feedId], req._t('Activity'), 'activity'],
          [[feedId, 'repos'], req._t('Repos'), 'repos'],
          [[feedId, 'digs'], req._t('ReposDug'), 'digs'],
        ], page)),
        body
      ])))
    })
  })
}

U.serveUserActivity = function (req, feedId) {
  return this.renderUserPage(req, feedId, 'activity', null,
    this.web.renderFeed(req, feedId))
}

U.serveUserRepos = function (req, feedId) {
  var self = this
  var title = req._t('UsersRepos', {name: '%{name}'})
  return self.renderUserPage(req, feedId, 'repos', title, pull(
    cat([
      self.web.ssb.messagesByType({
        type: 'git-update',
        reverse: true
      }),
      self.web.ssb.messagesByType({
        type: 'git-repo',
        reverse: true
      })
    ]),
    pull.filter(function (msg) {
      return msg.value.author == feedId
    }),
    pull.unique(function (msg) {
      return msg.value.content.repo || msg.key
    }),
    pull.take(20),
    paramap(function (msg, cb) {
      var repoId = msg.value.content.repo || msg.key
      var done = multicb({ pluck: 1, spread: true })
      self.web.getRepoName(feedId, repoId, done())
      self.web.getVotes(repoId, done())
      done(function (err, repoName, votes) {
        if (err) return cb(err)
        cb(null, '<section class="collapse">' +
          '<span class="right-bar">' +
          '<i>✌</i> ' +
          u.link([repoId, 'digs'], votes.upvotes, true,
            ' title="' + req._t('Digs') + '"') +
          '</span>' +
          '<strong>' + u.link([repoId], repoName) + '</strong>' +
          '<div class="date-info">' +
          req._t(msg.value.content.type == 'git-update' ?
            'UpdatedOnDate' : 'CreatedOnDate',
          {
            date: u.timestamp(msg.value.timestamp, req)
          }) + '</div>' +
        '</section>')
      })
    }, 8)
  ))
}

U.serveUserDigs = function (req, feedId) {
  var self = this
  var title = req._t('UsersReposDug', {name: '%{name}'})
  return self.renderUserPage(req, feedId, 'digs', title, pull(
    self.web.ssb.links({
      source: feedId,
      rel: 'vote',
      dest: '%',
      reverse: true,
      values: true
    }),
    pull.unique('dest'),
    u.sortMsgs(true),
    paramap(function (link, cb) {
      if (!link.dest) return cb()
      self.web.getMsg(link.dest, function (err, destMsg) {
        if (err) return cb(err)
        if (destMsg.content.type != 'git-repo') return cb()
        var vote = link.value.content && link.value.content.vote
        if (!(vote && vote.value > 0)) return cb()
        var repoId = link.dest
        var repoAuthor = destMsg.author
        var done = multicb({ pluck: 1, spread: true })
        self.web.getRepoName(repoAuthor, repoId, done())
        self.web.about.getName(repoAuthor, done())
        done(function (err, repoName, authorName) {
          var authorLink = u.link([repoAuthor], authorName)
          var repoLink = u.link([repoId], repoName)
          if (err) return cb(err)
          cb(null, '<section class="collapse">' +
            '<strong class="bgslash">' +
              authorLink + ' / ' + repoLink + '</strong>' +
            '<div class="date-info">' +
            req._t('DugOnDate', {
              date: u.timestamp(link.value.timestamp, req)
            }) + '</div>' +
          '</section>')
        })
      })
    }, 12),
    pull.filter()
  ))
}
