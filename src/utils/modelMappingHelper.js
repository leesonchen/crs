const KEEP_MODEL_TOKEN = '<keep>'
const WILDCARD_MODEL_KEY = '*'

function normalizeModelMapping(input, options = {}) {
  const keepToken = options.keepToken || KEEP_MODEL_TOKEN

  if (!input) {
    return {}
  }

  if (Array.isArray(input)) {
    const normalized = {}
    input.forEach((value) => {
      if (typeof value !== 'string') {
        return
      }

      const model = value.trim()
      if (!model) {
        return
      }

      normalized[model] = keepToken
    })
    return normalized
  }

  if (typeof input !== 'object') {
    return {}
  }

  const normalized = {}
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (typeof rawKey !== 'string') {
      continue
    }

    const key = rawKey.trim()
    if (!key) {
      continue
    }

    if (typeof rawValue !== 'string') {
      continue
    }

    const value = rawValue.trim()
    if (!value) {
      continue
    }

    normalized[key] = value
  }

  return normalized
}

function findMatchingModelKey(modelMapping, requestedModel) {
  const normalizedMapping = normalizeModelMapping(modelMapping)

  if (!requestedModel) {
    return null
  }

  if (Object.prototype.hasOwnProperty.call(normalizedMapping, requestedModel)) {
    return requestedModel
  }

  const requestedModelLower = requestedModel.toLowerCase()
  for (const key of Object.keys(normalizedMapping)) {
    if (key === WILDCARD_MODEL_KEY) {
      continue
    }

    if (key.toLowerCase() === requestedModelLower) {
      return key
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalizedMapping, WILDCARD_MODEL_KEY)) {
    return WILDCARD_MODEL_KEY
  }

  return null
}

function resolveMappedModel(modelMapping, requestedModel, options = {}) {
  const keepToken = options.keepToken || KEEP_MODEL_TOKEN
  const normalizedMapping = normalizeModelMapping(modelMapping, options)
  const hasRules = Object.keys(normalizedMapping).length > 0

  if (!requestedModel) {
    return {
      supported: true,
      hasRules,
      matchedKey: null,
      mappedValue: null,
      mappedModel: requestedModel,
      usedWildcard: false,
      keptOriginal: true
    }
  }

  if (!hasRules) {
    return {
      supported: true,
      hasRules: false,
      matchedKey: null,
      mappedValue: null,
      mappedModel: requestedModel,
      usedWildcard: false,
      keptOriginal: true
    }
  }

  const matchedKey = findMatchingModelKey(normalizedMapping, requestedModel)
  if (!matchedKey) {
    return {
      supported: false,
      hasRules: true,
      matchedKey: null,
      mappedValue: null,
      mappedModel: null,
      usedWildcard: false,
      keptOriginal: false
    }
  }

  const mappedValue = normalizedMapping[matchedKey]
  const keptOriginal = mappedValue === keepToken

  return {
    supported: true,
    hasRules: true,
    matchedKey,
    mappedValue,
    mappedModel: keptOriginal ? requestedModel : mappedValue,
    usedWildcard: matchedKey === WILDCARD_MODEL_KEY,
    keptOriginal
  }
}

function isModelSupported(modelMapping, requestedModel, options = {}) {
  return resolveMappedModel(modelMapping, requestedModel, options).supported
}

module.exports = {
  KEEP_MODEL_TOKEN,
  WILDCARD_MODEL_KEY,
  normalizeModelMapping,
  findMatchingModelKey,
  resolveMappedModel,
  isModelSupported
}
