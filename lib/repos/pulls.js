var pull = require('pull-stream')
var paramap = require('pull-paramap')
var cat = require('pull-cat')
var many = require('pull-many')
var multicb = require('multicb')
var GitRepo = require('pull-git-repo')
var u = require('../../lib/util')
var markdown = require('../../lib/markdown')
var forms = require('../../lib/forms')

module.exports = function (repoRoutes, web) {
  return new RepoPullReqRoutes(repoRoutes, web)
}

function RepoPullReqRoutes(repoRoutes, web) {
  this.repo = repoRoutes
  this.web = web
}

var P = RepoPullReqRoutes.prototype

/* Pull Request */

P.serveRepoPullReq = function (req, repo, pr, path, postId) {
  var self = this
  var headRepo, authorLink
  var page = path[0] || 'activity'
  var title = u.escape(pr.title) + ' · %{author}/%{repo}'
  return self.repo.renderRepoPage(req, repo, 'pulls', null, title, cat([
    pull.once('<div class="pull-request">' +
      forms.name(req, !self.web.isPublic, pr.id, pr.title,
        'issue-title', null, req._t('pullRequest.Rename'),
        '<h3>' + u.link([pr.id], pr.title) + '</h3>') +
      '<code>' + pr.id + '</code>'),
    u.readOnce(function (cb) {
      var done = multicb({ pluck: 1, spread: true })
      var gotHeadRepo = done()
      self.web.about.getName(pr.author, done())
      var sameRepo = (pr.headRepo == pr.baseRepo)
      self.web.getRepo(pr.headRepo, function (err, headRepo) {
        if (err) return cb(err)
        self.web.getRepoName(headRepo.feed, headRepo.id, done())
        self.web.about.getName(headRepo.feed, done())
        gotHeadRepo(null, GitRepo(headRepo))
      })

      done(function (err, _headRepo, issueAuthorName,
          headRepoName, headRepoAuthorName) {
        if (err) return cb(err)
        headRepo = _headRepo
        authorLink = u.link([pr.author], issueAuthorName)
        var repoLink = u.link([pr.headRepo], headRepoName)
        var headRepoAuthorLink = u.link([headRepo.feed], headRepoAuthorName)
        var headRepoLink = u.link([headRepo.id], headRepoName)
        var headBranchLink = u.link([headRepo.id, 'tree', pr.headBranch])
        var baseBranchLink = u.link([repo.id, 'tree', pr.baseBranch])
        cb(null, '<section class="collapse">' +
          '<strong class="issue-status ' +
          (pr.open ? 'open' : 'closed') + '">' +
          req._t(pr.open ? 'issue.state.Open' : 'issue.state.Closed') +
          '</strong> ' +
          req._t('pullRequest.WantToMerge', {
            name: authorLink,
            base: '<code>' + baseBranchLink + '</code>',
            head: (sameRepo ?
              '<code>' + headBranchLink + '</code>' :
              '<code class="bgslash">' +
                headRepoAuthorLink + ' / ' +
                headRepoLink + ' / ' +
                headBranchLink + '</code>')
          }) + '</section>')
      })
    }),
    pull.once(
      u.nav([
        [[pr.id], req._t('Discussion'), 'activity'],
        [[pr.id, 'commits'], req._t('Commits'), 'commits'],
        [[pr.id, 'files'], req._t('Files'), 'files']
      ], page)),
    u.readNext(function (cb) {
      if (page == 'commits')
        self.renderPullReqCommits(req, pr, repo, headRepo, cb)
      else if (page == 'files')
        self.renderPullReqFiles(req, pr, repo, headRepo, cb)
      else cb(null,
        self.renderPullReqActivity(req, pr, repo, headRepo, authorLink, postId))
    })
  ]))
}

P.renderPullReqCommits = function (req, pr, baseRepo, headRepo, cb) {
  var self = this
  self.web.pullReqs.getRevs(pr.id, function (err, revs) {
    if (err) return cb(null, self.web.renderError(err))
    cb(null, cat([
      pull.once('<section>'),
      self.renderCommitLog(req, baseRepo, revs.base, headRepo, revs.head),
      pull.once('</section>')
    ]))
  })
}

P.renderPullReqFiles = function (req, pr, baseRepo, headRepo, cb) {
  var self = this
  self.web.pullReqs.getRevs(pr.id, function (err, revs) {
    if (err) return cb(null, self.web.renderError(err))
    cb(null, cat([
      pull.once('<section>'),
      self.repo.renderDiffStat(req,
        [baseRepo, headRepo], [revs.base, revs.head]),
      pull.once('</section>')
    ]))
  })
}

P.renderPullReqActivity = function (req, pr, repo, headRepo, authorLink, postId) {
  var self = this
  var msgTimeLink = u.link([pr.id],
    new Date(pr.created_at).toLocaleString(req._locale))
  var newestMsg = {key: pr.id, value: {timestamp: pr.created_at}}
  var isAuthor = (self.web.myId == pr.author) || (self.web.myId == repo.feed)
  return cat([
    u.readOnce(function (cb) {
      cb(null,
        '<section class="collapse">' +
          authorLink + ' &middot; ' + msgTimeLink +
          markdown(pr.text, repo) + '</section>')
    }),
    // render posts, edits, and updates
    pull(
      many([
        self.web.ssb.links({
          dest: pr.id,
          values: true
        }),
        u.readNext(function (cb) {
          cb(null, pull(
            self.web.ssb.links({
              dest: headRepo.id,
              source: headRepo.feed,
              rel: 'repo',
              values: true,
              reverse: true
            }),
            pull.take(function (link) {
              return link.value.timestamp > pr.created_at
            }),
            pull.filter(function (link) {
              return link.value.content.type == 'git-update'
                && ('refs/heads/' + pr.headBranch) in link.value.content.refs
            })
          ))
        })
      ]),
      self.web.addAuthorName(),
      pull.unique('key'),
      pull.through(function (msg) {
        if (msg.value.timestamp > newestMsg.value.timestamp)
          newestMsg = msg
      }),
      u.sortMsgs(),
      pull.map(function (item) {
        if (item.value.content.type == 'git-update')
          return self.renderBranchUpdate(req, pr, item)
        return self.repo.issues.renderIssueActivityMsg(req, repo, pr,
          req._t('pull request'), postId, item)
      })
    ),
    !self.web.isPublic && isAuthor && pr.open && pull.once(
      '<section class="merge-instructions">' +
      '<input type="checkbox" class="toggle" id="merge-instructions"/>' +
      '<h4><label for="merge-instructions" class="toggle-link"><a>' +
      req._t('mergeInstructions.MergeViaCmdLine') +
      '</a></label></h4>' +
      '<div class="contents">' +
      '<p>' + req._t('mergeInstructions.CheckOut') + '</p>' +
      '<pre>' +
      'git fetch ssb://' + u.escape(pr.headRepo) + ' ' +
        u.escape(pr.headBranch) + '\n' +
      'git checkout -b ' + u.escape(pr.headBranch) + ' FETCH_HEAD' +
      '</pre>' +
      '<p>' + req._t('mergeInstructions.MergeAndPush') + '</p>' +
      '<pre>' +
      'git checkout ' + u.escape(pr.baseBranch) + '\n' +
      'git merge ' + u.escape(pr.headBranch) + '\n' +
      'git push ssb ' + u.escape(pr.baseBranch) +
      '</pre>' +
      '</div></section>'),
    !self.web.isPublic && u.readOnce(function (cb) {
      cb(null, forms.issueComment(req, pr, repo, newestMsg.key,
				isAuthor, req._t('pull request')))
    })
  ])
}

P.renderBranchUpdate = function (req, pr, msg) {
  var authorLink = u.link([msg.value.author], msg.authorName)
  var msgLink = u.link([msg.key],
    new Date(msg.value.timestamp).toLocaleString(req._locale))
  var rev = msg.value.content.refs['refs/heads/' + pr.headBranch]
  if (!rev)
    return '<section class="collapse">' +
      req._t('NameDeletedBranch', {
        name: authorLink,
        branch: '<code>' + pr.headBranch + '</code>'
      }) + ' &middot; ' + msgLink +
      '</section>'

  var revLink = u.link([pr.headRepo, 'commit', rev], rev.substr(0, 8))
  return '<section class="collapse">' +
    req._t('NameUpdatedBranch', {
      name: authorLink,
      rev: '<code>' + revLink + '</code>'
    }) + ' &middot; ' + msgLink +
    '</section>'
}

/* Compare changes */

P.serveRepoCompare = function (req, repo) {
  var self = this
  var query = req._u.query
  var base
  var count = 0
  var title = req._t('CompareChanges') + ' · %{author}/%{repo}'

  return self.repo.renderRepoPage(req, repo, 'pulls', null, title, cat([
    pull.once('<h3>' + req._t('CompareChanges') + '</h3>' +
      '<form action="' + u.encodeLink(repo.id) + '/comparing" method="get">' +
      '<section>'),
    pull.once(req._t('BaseBranch') + ': '),
    u.readNext(function (cb) {
      if (query.base) gotBase(null, query.base)
      else repo.getSymRef('HEAD', true, gotBase)
      function gotBase(err, ref) {
        if (err) return cb(err)
        cb(null, branchMenu(repo, 'base', base = ref || 'HEAD'))
      }
    }),
    pull.once('<br/>' + req._t('ComparisonRepoBranch') + ':'),
    pull(
      self.repo.getForks(repo, true),
      pull.asyncMap(function (msg, cb) {
        self.web.getRepo(msg.key, function (err, repo) {
          if (err) return cb(err)
          cb(null, {
            msg: msg,
            repo: repo
          })
        })
      }),
      pull.map(renderFork),
      pull.flatten()
    ),
    pull.once('</section>'),
    u.readOnce(function (cb) {
      cb(null, count == 0 ? req._t('NoBranches') :
        '<button type="submit" class="btn">' +
        req._t('Compare') + '</button>')
    }),
    pull.once('</form>')
  ]))

  function renderFork(fork) {
    return pull(
      fork.repo.refs(),
      pull.map(function (ref) {
        var m = /^refs\/([^\/]*)\/(.*)$/.exec(ref.name) || [,ref.name]
        return {
          type: m[1],
          name: m[2],
          value: ref.value
        }
      }),
      pull.filter(function (ref) {
        return ref.type == 'heads'
          && !(ref.name == base && fork.msg.key == repo.id)
      }),
      pull.map(function (ref) {
        var branchLink = u.link([fork.msg.key, 'tree', ref.name], ref.name)
        var authorLink = u.link([fork.msg.value.author], fork.msg.authorName)
        var repoLink = u.link([fork.msg.key], fork.msg.repoName)
        var value = fork.msg.key + ':' + ref.name
        count++
        return '<div class="bgslash">' +
          '<input type="radio" name="head"' +
          ' value="' + u.escape(value) + '"' +
          (query.head == value ? ' checked="checked"' : '') + '> ' +
          authorLink + ' / ' + repoLink + ' / ' + branchLink + '</div>'
      })
    )
  }
}

P.serveRepoComparing = function (req, repo) {
  var self = this
  var query = req._u.query
  var baseBranch = query.base
  var s = (query.head || '').split(':')

  if (!s || !baseBranch)
    return self.web.serveRedirect(req, u.encodeLink([repo.id, 'compare']))

  var headRepoId = s[0]
  var headBranch = s[1]
  var baseLink = u.link([repo.id, 'tree', baseBranch])
  var headBranchLink = u.link([headRepoId, 'tree', headBranch])
  var backHref = u.encodeLink([repo.id, 'compare']) + req._u.search
  var title = req._t(query.expand ? 'OpenPullRequest': 'ComparingChanges')
  var pageTitle = title + ' · %{author}/%{repo}'

  return self.repo.renderRepoPage(req, repo, 'pulls', null, pageTitle, cat([
    pull.once('<h3>' + title + '</h3>'),
    u.readNext(function (cb) {
      self.web.getRepo(headRepoId, function (err, headRepo) {
        if (err) return cb(err)
        self.web.getRepoFullName(headRepo.feed, headRepo.id,
          function (err, repoName, authorName) {
            if (err) return cb(err)
            cb(null, renderRepoInfo(GitRepo(headRepo), repoName, authorName))
          }
        )
      })
    })
  ]))

  function renderRepoInfo(headRepo, headRepoName, headRepoAuthorName) {
    var authorLink = u.link([headRepo.feed], headRepoAuthorName)
    var repoLink = u.link([headRepoId], headRepoName)
    return cat([
      pull.once('<section>' +
        req._t('Base') + ': ' + baseLink + '<br/>' +
        req._t('Head') + ': ' +
        '<span class="bgslash">' + authorLink + ' / ' + repoLink +
        ' / ' + headBranchLink + '</span>' +
        '</section>' +
        (query.expand ? '<section><form method="post" action="">' +
          hiddenInputs({
            action: 'new-pull',
            branch: baseBranch,
            head_repo: headRepoId,
            head_branch: headBranch
          }) +
          '<input class="wide-input" name="title"' +
          ' placeholder="' + req._t('Title') + '" size="77"/>' +
          forms.post(req, repo, req._t('Description'), 8) +
          '<button type="submit" class="btn open">' +
            req._t('Create') + '</button>' +
          '</form></section>'
        : '<section><form method="get" action="">' +
          hiddenInputs({
            base: baseBranch,
            head: query.head
          }) +
          '<button class="btn open" type="submit" name="expand" value="1">' +
            '<i>⎇</i> ' + req._t('CreatePullRequest') + '</button> ' +
          '<a href="' + backHref + '">' + req._t('Back') + '</a>' +
          '</form></section>') +
        '<div id="commits"></div>' +
        '<div class="tab-links">' +
          '<a href="#" id="files-link">' + req._t('FilesChanged') + '</a> ' +
          '<a href="#commits" id="commits-link">' +
            req._t('Commits') + '</a>' +
        '</div>' +
        '<section id="files-tab">'),
      self.repo.renderDiffStat(req, [repo, headRepo],
        [baseBranch, headBranch]),
      pull.once('</section>' +
        '<section id="commits-tab">'),
      self.renderCommitLog(req, repo, baseBranch, headRepo, headBranch),
      pull.once('</section>')
    ])
  }
}

P.renderCommitLog = function (req, baseRepo, baseBranch, headRepo, headBranch) {
  return cat([
    pull.once('<table class="compare-commits">'),
    u.readNext(function (cb) {
      baseRepo.resolveRef(baseBranch, function (err, baseBranchRev) {
        if (err) return cb(err)
        var currentDay
        return cb(null, pull(
          headRepo.readLog(headBranch),
          pull.take(function (rev) { return rev != baseBranchRev }),
          u.pullReverse(),
          paramap(headRepo.getCommitParsed.bind(headRepo), 8),
          pull.map(function (commit) {
            var commitPath = [headRepo.id, 'commit', commit.id]
            var commitIdShort = '<tt>' + commit.id.substr(0, 8) + '</tt>'
            var day = Math.floor(commit.author.date / 86400000)
            var dateRow = day == currentDay ? '' :
              '<tr><th colspan=3 class="date-info">' +
              commit.author.date.toLocaleDateString(req._locale) +
              '</th><tr>'
            currentDay = day
            return dateRow + '<tr>' +
              '<td>' + u.escape(commit.author.name) + '</td>' +
              '<td>' + u.link(commitPath, commit.title) + '</td>' +
              '<td>' + u.link(commitPath, commitIdShort, true) + '</td>' +
              '</tr>'
          })
        ))
      })
    }),
    pull.once('</table>')
  ])
}
