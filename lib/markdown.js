var path = require('path')
var marked = require('ssb-marked')
var ref = require('ssb-ref')
var u = require('./util')

// render links to git objects and ssb objects
var blockRenderer = new marked.Renderer()
blockRenderer.urltransform = function (url) {
  if (ref.isLink(url))
    return u.encodeLink(url)
  if (/^[0-9a-f]{40}$/.test(url) && this.options.repo)
    return u.encodeLink([this.options.repo.id, 'commit', url])
  return url
}

blockRenderer.image = function (href, title, text) {
  href = href.replace(/^&amp;/, '&')
  var url
  if (ref.isBlobId(href))
    url = u.encodeLink(href)
  else if (/^https?:\/\//.test(href))
    url = href
  else if (this.options.repo && this.options.rev && this.options.path)
    url = path.join('/', encodeURIComponent(this.options.repo.id),
      'raw', this.options.rev, this.options.path.join('/'), href)
  else
    return text
  return '<img src="' + u.escape(url) + '" alt="' + text + '"' +
    (title ? ' title="' + title + '"' : '') + '/>'
}

blockRenderer.mention = function (preceding, id) {
  // prevent broken name mention
  if (id[0] == '@' && !ref.isFeed(id))
    return (preceding||'') + u.escape(id)

  return marked.Renderer.prototype.mention.call(this, preceding, id)
}

marked.setOptions({
  gfm: true,
  mentions: true,
  tables: true,
  breaks: true,
  pedantic: false,
  sanitize: true,
  smartLists: true,
  smartypants: false,
  highlight: u.highlight,
  renderer: blockRenderer
})

// hack to make git link mentions work
var mdRules = new marked.InlineLexer(1, marked.defaults).rules
mdRules.mention =
  /^(\s)?([@%&][A-Za-z0-9\._\-+=\/]*[A-Za-z0-9_\-+=\/]|[0-9a-f]{40})/
mdRules.text = /^[\s\S]+?(?=[\\<!\[_*`]| {2,}\n| [@%&]|[0-9a-f]{40}|$)/

module.exports = function (text, options, cb) {
  if (!text) return ''
  if (typeof text != 'string') text = String(text)
  if (!options) options = {}
  else if (options.id) options = {repo: options}
  if (!options.rev) options.rev = 'HEAD'
  if (!options.path) options.path = []

  return marked(text, options, cb)
}
