import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { showToast } from '@/utils/tools'
import request from '@/utils/request'

export const useBridgeStore = defineStore('bridge', () => {
  // 状态
  const loading = ref(false)
  const saving = ref(false)

  // 双向桥接配置数据结构
  const bridgeConfig = ref({
    openaiToClaude: {
      enabled: false, // ✅ 初始值设为 false，避免误导
      defaultModel: 'claude-3-5-sonnet-20241022',
      modelMapping: {}
    },
    claudeToOpenai: {
      enabled: false, // ✅ 初始值设为 false，与后端默认保持一致
      defaultModel: 'gpt-5',
      modelMapping: {}
    },
    createdAt: null,
    updatedAt: null,
    updatedBy: null
  })

  // 监听配置变化
  watch(
    bridgeConfig,
    () => {
      // 监听桥接配置变化，便于调试
    },
    { deep: true, immediate: true }
  )

  // 加载桥接配置
  async function loadBridgeConfig() {
    loading.value = true
    try {
      const response = await request({ url: '/admin/bridge/config', method: 'GET' })

      if (response.success && response.data) {
        // 处理后端返回的桥接配置
        const newConfig = {
          openaiToClaude: {
            enabled:
              response.data.openaiToClaude?.enabled !== undefined
                ? response.data.openaiToClaude.enabled
                : false,
            defaultModel:
              response.data.openaiToClaude?.defaultModel ?? 'claude-3-5-sonnet-20241022',
            modelMapping: response.data.openaiToClaude?.modelMapping ?? {}
          },
          claudeToOpenai: {
            enabled:
              response.data.claudeToOpenai?.enabled !== undefined
                ? response.data.claudeToOpenai.enabled
                : false,
            defaultModel: response.data.claudeToOpenai?.defaultModel ?? 'gpt-5',
            modelMapping: response.data.claudeToOpenai?.modelMapping ?? {}
          },
          createdAt: response.data.createdAt || null,
          updatedAt: response.data.updatedAt || null,
          updatedBy: response.data.updatedBy || null
        }

        // 更新状态
        bridgeConfig.value = newConfig
      } else {
        showToast('API响应格式异常', 'error')
      }
    } catch (error) {
      showToast('加载桥接配置失败', 'error')
      throw error
    } finally {
      loading.value = false
    }
  }

  // 保存桥接配置
  async function saveBridgeConfig(config) {
    // 验证配置
    const validation = validateBridgeConfig(config)
    if (!validation.isValid) {
      showToast(validation.error, 'error')
      return { success: false, message: validation.error }
    }

    saving.value = true
    try {
      const response = await request({ url: '/admin/bridge/config', method: 'PUT', data: config })
      if (response.success) {
        // 更新本地状态
        bridgeConfig.value = {
          openaiToClaude: {
            enabled:
              response.data.openaiToClaude?.enabled !== undefined
                ? response.data.openaiToClaude.enabled
                : false,
            defaultModel:
              response.data.openaiToClaude?.defaultModel ?? 'claude-3-5-sonnet-20241022',
            modelMapping: response.data.openaiToClaude?.modelMapping ?? {}
          },
          claudeToOpenai: {
            enabled:
              response.data.claudeToOpenai?.enabled !== undefined
                ? response.data.claudeToOpenai.enabled
                : false,
            defaultModel: response.data.claudeToOpenai?.defaultModel ?? 'gpt-5',
            modelMapping: response.data.claudeToOpenai?.modelMapping ?? {}
          },
          createdAt: response.data.createdAt || null,
          updatedAt: response.data.updatedAt || null,
          updatedBy: response.data.updatedBy || null
        }
        showToast('桥接配置已保存', 'success')
        return { success: true, config: response.data }
      } else {
        showToast(response.message || '保存失败', 'error')
        return { success: false, message: response.message }
      }
    } catch (error) {
      console.error('Failed to save bridge config:', error)
      const errorMessage = error.message || error.error || '保存桥接配置失败'
      showToast(errorMessage, 'error')
      return { success: false, message: errorMessage }
    } finally {
      saving.value = false
    }
  }

  // 验证单个方向的配置
  function validateDirectionConfig(directionConfig, directionName, sourcePattern, targetPattern) {
    // 验证 enabled 字段
    if (typeof directionConfig.enabled !== 'boolean') {
      return {
        isValid: false,
        error: `${directionName}: enabled 字段必须是布尔值`
      }
    }

    // 如果未启用，不需要验证其他字段
    if (!directionConfig.enabled) {
      return { isValid: true }
    }

    // 验证 defaultModel 字段
    if (!directionConfig.defaultModel || typeof directionConfig.defaultModel !== 'string') {
      return {
        isValid: false,
        error: `${directionName}: 必须指定默认模型`
      }
    }

    // 验证 defaultModel 格式
    if (!targetPattern.test(directionConfig.defaultModel)) {
      return {
        isValid: false,
        error: `${directionName}: 默认模型格式无效 (${directionConfig.defaultModel})`
      }
    }

    // 验证 modelMapping 字段
    if (directionConfig.modelMapping && typeof directionConfig.modelMapping !== 'object') {
      return {
        isValid: false,
        error: `${directionName}: 模型映射必须是对象格式`
      }
    }

    // 验证每个模型映射的格式
    if (directionConfig.modelMapping) {
      for (const [sourceModel, targetModel] of Object.entries(directionConfig.modelMapping)) {
        // 验证源模型名称格式
        if (!sourcePattern.test(sourceModel)) {
          return {
            isValid: false,
            error: `${directionName}: 源模型名称格式无效 (${sourceModel})`
          }
        }

        // 验证目标模型名称格式
        if (!targetPattern.test(targetModel)) {
          return {
            isValid: false,
            error: `${directionName}: 目标模型名称格式无效 (${targetModel})`
          }
        }
      }
    }

    return { isValid: true }
  }

  // 验证桥接配置（双向）
  function validateBridgeConfig(config) {
    // 验证 OpenAI → Claude 方向
    if (config.openaiToClaude) {
      const result = validateDirectionConfig(
        config.openaiToClaude,
        'OpenAI → Claude',
        /^gpt-[a-z0-9-]+$/i, // OpenAI 模型格式
        /^claude-[a-z0-9.-]+$/i // Claude 模型格式
      )
      if (!result.isValid) {
        return result
      }
    }

    // 验证 Claude → OpenAI 方向
    if (config.claudeToOpenai) {
      const result = validateDirectionConfig(
        config.claudeToOpenai,
        'Claude → OpenAI',
        /^claude-[a-z0-9.-]+$/i, // Claude 模型格式
        /^gpt-[a-z0-9-]+$/i // OpenAI 模型格式
      )
      if (!result.isValid) {
        return result
      }
    }

    return { isValid: true }
  }

  // 验证单个模型映射（需要指定方向）
  function validateModelMapping(direction, sourceModel, targetModel) {
    const isOpenaiToClaude = direction === 'openaiToClaude'
    const sourcePattern = isOpenaiToClaude ? /^gpt-[a-z0-9-]+$/i : /^claude-[a-z0-9.-]+$/i
    const targetPattern = isOpenaiToClaude ? /^claude-[a-z0-9.-]+$/i : /^gpt-[a-z0-9-]+$/i
    const sourceLabel = isOpenaiToClaude ? 'OpenAI' : 'Claude'
    const targetLabel = isOpenaiToClaude ? 'Claude' : 'OpenAI'

    // 验证源模型名称
    if (!sourceModel || typeof sourceModel !== 'string') {
      return {
        isValid: false,
        field: 'source',
        error: `${sourceLabel} 模型名称不能为空`
      }
    }

    if (!sourcePattern.test(sourceModel)) {
      return {
        isValid: false,
        field: 'source',
        error: `${sourceLabel} 模型名称格式无效（例如：${isOpenaiToClaude ? 'gpt-5' : 'claude-3-5-sonnet-20241022'}）`
      }
    }

    // 验证目标模型名称
    if (!targetModel || typeof targetModel !== 'string') {
      return {
        isValid: false,
        field: 'target',
        error: `${targetLabel} 模型名称不能为空`
      }
    }

    if (!targetPattern.test(targetModel)) {
      return {
        isValid: false,
        field: 'target',
        error: `${targetLabel} 模型名称格式无效（例如：${isOpenaiToClaude ? 'claude-3-5-sonnet-20241022' : 'gpt-5'}）`
      }
    }

    return { isValid: true }
  }

  // 添加模型映射（需要指定方向）
  function addModelMapping(direction, sourceModel, targetModel) {
    // 验证方向参数
    if (direction !== 'openaiToClaude' && direction !== 'claudeToOpenai') {
      return {
        isValid: false,
        error: '无效的方向参数'
      }
    }

    // 验证格式
    const validation = validateModelMapping(direction, sourceModel, targetModel)
    if (!validation.isValid) {
      return validation
    }

    // 检查是否重复
    if (bridgeConfig.value[direction].modelMapping[sourceModel]) {
      const sourceLabel = direction === 'openaiToClaude' ? 'OpenAI' : 'Claude'
      return {
        isValid: false,
        field: 'source',
        error: `${sourceLabel} 模型名称已存在`
      }
    }

    // 添加映射
    bridgeConfig.value[direction].modelMapping[sourceModel] = targetModel

    return { isValid: true }
  }

  // 删除模型映射（需要指定方向）
  function removeModelMapping(direction, sourceModel) {
    // 验证方向参数
    if (direction !== 'openaiToClaude' && direction !== 'claudeToOpenai') {
      return false
    }

    if (bridgeConfig.value[direction].modelMapping[sourceModel]) {
      delete bridgeConfig.value[direction].modelMapping[sourceModel]
      return true
    }
    return false
  }

  // 更新模型映射（需要指定方向）
  function updateModelMapping(direction, oldSourceModel, newSourceModel, newTargetModel) {
    // 验证方向参数
    if (direction !== 'openaiToClaude' && direction !== 'claudeToOpenai') {
      return {
        isValid: false,
        error: '无效的方向参数'
      }
    }

    const sourceLabel = direction === 'openaiToClaude' ? 'OpenAI' : 'Claude'

    // 如果源模型名称改变，检查新名称是否重复
    if (
      oldSourceModel !== newSourceModel &&
      bridgeConfig.value[direction].modelMapping[newSourceModel]
    ) {
      return {
        isValid: false,
        field: 'source',
        error: `新的 ${sourceLabel} 模型名称已存在`
      }
    }

    // 验证格式
    const validation = validateModelMapping(direction, newSourceModel, newTargetModel)
    if (!validation.isValid) {
      return validation
    }

    // 删除旧映射
    if (oldSourceModel !== newSourceModel) {
      delete bridgeConfig.value[direction].modelMapping[oldSourceModel]
    }

    // 添加新映射
    bridgeConfig.value[direction].modelMapping[newSourceModel] = newTargetModel

    return { isValid: true }
  }

  // 重置为默认配置
  function resetToDefaults() {
    bridgeConfig.value = {
      openaiToClaude: {
        enabled: true,
        defaultModel: 'claude-3-5-sonnet-20241022',
        modelMapping: {
          'gpt-5': 'claude-sonnet-4-20250514',
          'gpt-5-plus': 'claude-opus-4-20250514',
          'gpt-5-mini': 'claude-3-5-haiku-20241022'
        }
      },
      claudeToOpenai: {
        enabled: false,
        defaultModel: 'gpt-5',
        modelMapping: {
          'claude-sonnet-4-20250514': 'gpt-5',
          'claude-opus-4-20250514': 'gpt-5-plus',
          'claude-3-5-haiku-20241022': 'gpt-5-mini'
        }
      },
      createdAt: null,
      updatedAt: null,
      updatedBy: null
    }
  }

  return {
    // 状态
    loading,
    saving,
    bridgeConfig,

    // 方法
    loadBridgeConfig,
    saveBridgeConfig,
    validateBridgeConfig,
    validateModelMapping,
    addModelMapping,
    removeModelMapping,
    updateModelMapping,
    resetToDefaults
  }
})
