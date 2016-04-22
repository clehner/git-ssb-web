module.exports = function (onFirst, through, onLast, onEmpty) {
  var ended, last, first = true, queue = []
  return function (read) {
    var mappedRead = through(function (end, cb) {
      if (ended = end) return read(ended, cb)
      if (queue.length)
        return cb(null, queue.shift())
      read(null, function (end, data) {
        if (end) return cb(end)
        last = data
        cb(null, data)
      })
    })
    return function (end, cb) {
      var tmp
      if (ended) return cb(ended)
      if (ended = end) return read(ended, cb)
      if (first)
        return read(null, function (end, data) {
          if (ended = end) {
            if (end === true && onEmpty)
              return onEmpty(cb)
            return cb(ended)
          }
          first = false
          last = data
          queue.push(data)
          if (onFirst)
            onFirst(data, cb)
          else
            mappedRead(null, cb)
        })
      mappedRead(null, function (end, data) {
        if (ended = end) {
          if (end === true && last)
            return onLast(last, cb)
        }
        cb(end, data)
      })
    }
  }
}

