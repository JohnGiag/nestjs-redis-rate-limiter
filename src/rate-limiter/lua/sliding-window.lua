-- Sliding window rate limiter (atomic: Redis runs the whole script without interleaving).
-- KEYS[1] = bucket key
-- ARGV[1] = limit (max requests per window)
-- ARGV[2] = window length in milliseconds
-- ARGV[3] = unique member id for this request
-- Returns { allowed (1/0), remaining, resetSeconds }

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[3]

-- Use the Redis clock, not the caller's, so app instances with skewed clocks agree.
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)

local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, member)
  count = count + 1
  allowed = 1
end

redis.call('PEXPIRE', key, windowMs)

-- A slot frees up when the oldest entry leaves the window.
local resetMs = windowMs
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] then
  resetMs = tonumber(oldest[2]) + windowMs - now
end

-- max(): after a limit is lowered, a window can hold more entries than the new limit.
return { allowed, math.max(limit - count, 0), math.ceil(resetMs / 1000) }
