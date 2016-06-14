var pull = require('pull-stream')
var cat = require('pull-cat')
var u = require('../util')
var markdown = require('../markdown')
var forms = require('../forms')

module.exports = function (repoRoutes, web) {
  return new RepoIssueRoutes(repoRoutes, web)
}

function RepoIssueRoutes(repoRoutes, web) {
  this.repo = repoRoutes
  this.web = web
}

var I = RepoIssueRoutes.prototype

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

/* Issues */

I.serveRepoIssues = function (req, repo, isPRs) {
  var self = this
  var count = 0
  var state = req._u.query.state || 'open'
  var newPath = isPRs ? [repo.id, 'compare'] : [repo.id, 'issues', 'new']
  var title = req._t('Issues') + ' · %{author}/%{repo}'
  var page = isPRs ? 'pulls' : 'issues'
  return self.repo.renderRepoPage(req, repo, page, null, title, cat([
    pull.once(
      (self.web.isPublic ? '' :
        '<form class="right-bar" method="get"' +
          ' action="' + u.encodeLink(newPath) + '">' +
          '<button class="btn">&plus; ' +
            req._t(isPRs ? 'pullRequest.New' : 'issue.New') +
          '</button>' +
        '</form>') +
      '<h3>' + req._t(isPRs ? 'PullRequests' : 'Issues') + '</h3>' +
      u.nav([
        ['?', req._t('issues.Open'), 'open'],
        ['?state=closed', req._t('issues.Closed'), 'closed'],
        ['?state=all', req._t('issues.All'), 'all']
      ], state)),
    pull(
      (isPRs ? self.web.pullReqs : self.web.issues).list({
        repo: repo.id,
        project: repo.id,
        reverse: true,
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
          '<a href="' + u.encodeLink(issue.id) + '">' +
            u.escape(issue.title) +
            '<span class="right-bar">' +
              new Date(issue.created_at).toLocaleString(req._locale) +
            '</span>' +
          '</a>' +
          '</section>'
      })
    ),
    u.readOnce(function (cb) {
      cb(null, count > 0 ? '' :
        '<p>' + req._t(isPRs ? 'NoPullRequests' : 'NoIssues') + '</p>')
    })
  ]))
}

/* New Issue */

I.serveRepoNewIssue = function (req, repo, issueId, path) {
  var title = req._t('issue.New') + ' · %{author}/%{repo}'
  return this.repo.renderRepoPage(req, repo, 'issues', null, title, pull.once(
    '<h3>' + req._t('issue.New') + '</h3>' +
    '<section><form action="" method="post">' +
    '<input type="hidden" name="action" value="new-issue">' +
    '<p><input class="wide-input" name="title" placeholder="' +
      req._t('issue.Title') + '" size="77" /></p>' +
    forms.post(req, repo, req._t('Description'), 8) +
    '<button type="submit" class="btn">' + req._t('Create') + '</button>' +
    '</form></section>'))
}

/* Issue */

I.serveRepoIssue = function (req, repo, issue, path, postId) {
  var self = this
  var isAuthor = (self.web.myId == issue.author)
    || (self.web.myId == repo.feed)
  var newestMsg = {key: issue.id, value: {timestamp: issue.created_at}}
  var title = u.escape(issue.title) + ' · %{author}/%{repo}'
  return self.repo.renderRepoPage(req, repo, 'issues', null, title, cat([
    pull.once(
      forms.name(req, !self.web.isPublic, issue.id, issue.title,
        'issue-title', null, req._t('issue.Rename'),
        '<h3>' + u.link([issue.id], issue.title) + '</h3>') +
      '<code>' + issue.id + '</code>' +
      '<section class="collapse">' +
      (issue.open
        ? '<strong class="issue-status open">' +
          req._t('issue.state.Open') + '</strong>'
        : '<strong class="issue-status closed">' +
          req._t('issue.state.Closed') + '</strong>')),
    u.readOnce(function (cb) {
      self.web.about.getName(issue.author, function (err, authorName) {
        if (err) return cb(err)
        var authorLink = u.link([issue.author], authorName)
        cb(null, req._t('issue.Opened',
          {name: authorLink, datetime: u.timestamp(issue.created_at, req)}))
      })
    }),
    pull.once('<hr/>' + markdown(issue.text, repo) + '</section>'),
    // render posts and edits
    pull(
      self.web.ssb.links({
        dest: issue.id,
        values: true
      }),
      pull.unique('key'),
      self.web.addAuthorName(),
      u.sortMsgs(),
      pull.through(function (msg) {
        // the newest message in the issue thread
        // becomes the branch of the new post
        if (msg.value
         && msg.value.timestamp > newestMsg.value.timestamp
         && msg.value.content.root == issue.id)
          newestMsg = msg
      }),
      pull.map(self.renderIssueActivityMsg.bind(self, req, repo, issue,
        req._t('issue.'), postId))
    ),
    self.web.isPublic ? pull.empty() : u.readOnce(function (cb) {
      cb(null, forms.issueComment(req, issue, repo,
        newestMsg.key, isAuthor, req._t('issue.')))
    })
  ]))
}

I.renderIssueActivityMsg = function (req, repo, issue, type, postId, msg) {
  var authorLink = u.link([msg.value.author], msg.authorName)
  var msgHref = u.encodeLink(msg.key) + '#' + encodeURIComponent(msg.key)
  var msgTimeLink = '<a href="' + msgHref + '"' +
    ' name="' + u.escape(msg.key) + '">' +
    new Date(msg.value.timestamp).toLocaleString(req._locale) + '</a>'
  var c = msg.value.content
  switch (c.type) {
    case 'vote':
      return ''
    case 'post':
      if (c.root == issue.id) {
        var changed = this.web.issues.isStatusChanged(msg, issue)
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
          post: u.link([msg.key], String(c.title || msg.key).substr(0, 140))
        }) + '</section>'
    case 'issue-edit':
      return '<section class="collapse">' +
        (msg.key == postId ? '<div class="highlight">' : '') +
        (c.title == null ? '' : req._t('issue.Renamed', {
          author: authorLink,
          type: type,
          name: '<q>' + u.escape(c.title) + '</q>'
        })) + ' &middot; ' + msgTimeLink +
        (msg.key == postId ? '</div>' : '') +
        '</section>'
    case 'git-update':
      var mention = this.web.issues.getMention(msg, issue)
      if (mention) {
        var commitLink = u.link([repo.id, 'commit', mention.object],
          mention.label || mention.object)
        return '<section class="collapse">' +
          req._t(mention.open ? 'issue.Reopened' : 'issue.Closed', {
            name: authorLink,
            type: type
          }) + ' &middot; ' + msgTimeLink + '<br/>' +
          commitLink +
          '</section>'
      } else if ((mention = getMention(msg, issue.id))) {
        var commitLink = u.link(mention.object ?
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
        u.json(c) +
        '</section>'
  }
}
