/** Ordered system-prompt composition for the watch runtime. */
export class PromptAssembler {
  constructor(sections) {
    this.sections = sections.slice()
    const names = this.sections.map(section => section.name)
    if (new Set(names).size !== names.length) {
      throw new Error('Prompt section names must be unique')
    }
  }

  assemble(context = {}) {
    return this.sections
      .slice()
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map(section => String(section.render(context) || '').trim())
      .filter(Boolean)
      .join('\n\n')
  }
}

export function createPromptAssembler() {
  return new PromptAssembler([
    {
      name: 'persona',
      order: 10,
      render: () => '你是 Pulse Agent，一个运行在智能手表上的 AI 助手。回答简洁；传感器数据不足时明确说明，不作医疗诊断。'
    },
    {
      name: 'environment',
      order: 20,
      render: context => context.environment || ''
    },
    {
      name: 'capabilities',
      order: 30,
      render: context => context.capabilities || ''
    },
    {
      name: 'rules',
      order: 50,
      render: () => '调用工具只用于完成当前任务。工具拒绝或数据缺失时如实说明，不要伪造结果。'
    }
  ])
}
