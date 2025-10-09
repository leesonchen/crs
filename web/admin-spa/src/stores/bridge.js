import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiClient } from '@/config/api'
import { showToast } from '@/utils/toast'

export const useBridgeStore = defineStore('bridge', () => {
  // 状态
  const loading = ref(false)
  const saving = ref(false)
  const bridgeConfig = ref({
    enabled: true,
    defaultModel: 'gpt-5',
    modelMapping: {},
    createdAt: null,
    updatedAt: null,
    updatedBy: null
  })

  // 加载桥接配置
  async function loadBridgeConfig() {
    loading.value = true
    try {
      const response = await apiClient.get('/admin/bridge/config')
      if (response.success && response.config) {
        // 确保 modelMapping 始终是一个对象，防止 undefined/null 导致的错误
        bridgeConfig.value = {
          ...response.config,
          modelMapping: response.config.modelMapping || {}
        }
      }
    } catch (error) {
      console.error('Failed to load bridge config:', error)
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
      const response = await apiClient.put('/admin/bridge/config', config)
      if (response.success) {
        // 确保 modelMapping 始终是一个对象，防止 undefined/null 导致的错误
        bridgeConfig.value = {
          ...response.config,
          modelMapping: response.config.modelMapping || {}
        }
        showToast('桥接配置已保存', 'success')
        return { success: true, config: response.config }
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

  // 验证桥接配置
  function validateBridgeConfig(config) {
    // 验证 enabled 字段
    if (typeof config.enabled !== 'boolean') {
      return {
        isValid: false,
        error: 'enabled 字段必须是布尔值'
      }
    }

    // 验证 defaultModel 字段
    if (!config.defaultModel || typeof config.defaultModel !== 'string') {
      return {
        isValid: false,
        error: '默认模型不能为空'
      }
    }

    // 验证 modelMapping 字段
    if (config.modelMapping && typeof config.modelMapping !== 'object') {
      return {
        isValid: false,
        error: '模型映射必须是对象格式'
      }
    }

    // 验证模型映射格式
    if (config.modelMapping) {
      for (const [openaiModel, claudeModel] of Object.entries(config.modelMapping)) {
        // 验证 OpenAI 模型名称格式
        if (!/^gpt-[a-z0-9-]+$/i.test(openaiModel)) {
          return {
            isValid: false,
            error: `OpenAI 模型名称格式无效: ${openaiModel}`
          }
        }

        // 验证 Claude 模型名称格式
        if (!/^claude-[a-z0-9.-]+$/i.test(claudeModel)) {
          return {
            isValid: false,
            error: `Claude 模型名称格式无效: ${claudeModel}`
          }
        }
      }
    }

    return {
      isValid: true
    }
  }

  // 验证模型映射格式（单条）
  function validateModelMapping(openaiModel, claudeModel) {
    // 验证 OpenAI 模型名称
    if (!openaiModel || typeof openaiModel !== 'string') {
      return {
        isValid: false,
        field: 'openai',
        error: 'OpenAI 模型名称不能为空'
      }
    }

    if (!/^gpt-[a-z0-9-]+$/i.test(openaiModel)) {
      return {
        isValid: false,
        field: 'openai',
        error: 'OpenAI 模型名称格式无效（例如：gpt-5, gpt-5-plus）'
      }
    }

    // 验证 Claude 模型名称
    if (!claudeModel || typeof claudeModel !== 'string') {
      return {
        isValid: false,
        field: 'claude',
        error: 'Claude 模型名称不能为空'
      }
    }

    if (!/^claude-[a-z0-9.-]+$/i.test(claudeModel)) {
      return {
        isValid: false,
        field: 'claude',
        error: 'Claude 模型名称格式无效（例如：claude-3-5-sonnet-20241022）'
      }
    }

    return {
      isValid: true
    }
  }

  // 添加模型映射
  function addModelMapping(openaiModel, claudeModel) {
    // 验证格式
    const validation = validateModelMapping(openaiModel, claudeModel)
    if (!validation.isValid) {
      return validation
    }

    // 检查是否重复
    if (bridgeConfig.value.modelMapping[openaiModel]) {
      return {
        isValid: false,
        field: 'openai',
        error: 'OpenAI 模型名称已存在'
      }
    }

    // 添加映射
    bridgeConfig.value.modelMapping[openaiModel] = claudeModel

    return {
      isValid: true
    }
  }

  // 删除模型映射
  function removeModelMapping(openaiModel) {
    if (bridgeConfig.value.modelMapping[openaiModel]) {
      delete bridgeConfig.value.modelMapping[openaiModel]
      return true
    }
    return false
  }

  // 更新模型映射
  function updateModelMapping(oldOpenaiModel, newOpenaiModel, newClaudeModel) {
    // 如果 OpenAI 模型名称改变，检查新名称是否重复
    if (oldOpenaiModel !== newOpenaiModel && bridgeConfig.value.modelMapping[newOpenaiModel]) {
      return {
        isValid: false,
        field: 'openai',
        error: '新的 OpenAI 模型名称已存在'
      }
    }

    // 验证格式
    const validation = validateModelMapping(newOpenaiModel, newClaudeModel)
    if (!validation.isValid) {
      return validation
    }

    // 删除旧映射
    if (oldOpenaiModel !== newOpenaiModel) {
      delete bridgeConfig.value.modelMapping[oldOpenaiModel]
    }

    // 添加新映射
    bridgeConfig.value.modelMapping[newOpenaiModel] = newClaudeModel

    return {
      isValid: true
    }
  }

  // 重置为默认配置
  function resetToDefaults() {
    bridgeConfig.value = {
      enabled: true,
      defaultModel: 'gpt-5',
      modelMapping: {
        'gpt-5': 'claude-3-5-sonnet-20241022',
        'gpt-5-plus': 'claude-opus-4-20250514',
        'gpt-5-mini': 'claude-3-5-haiku-20241022'
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
