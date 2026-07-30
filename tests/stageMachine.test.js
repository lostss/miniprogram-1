const { evaluateStage, STAGES } = require('../cloudfunctions/_shared/domain/stageMachine')

describe('stageMachine', () => {
  test('missing engagement_stage defaults to onboarding', () => {
    expect(evaluateStage({}, 0)).toBe('onboarding')
  })

  test('onboarding stays if no policies', () => {
    expect(evaluateStage({ engagement_stage: 'onboarding' }, 0)).toBe('onboarding')
  })

  test('onboarding advances to profiling with 1+ policies', () => {
    expect(evaluateStage({ engagement_stage: 'onboarding' }, 1)).toBe('profiling')
    expect(evaluateStage({ engagement_stage: 'onboarding' }, 5)).toBe('profiling')
  })

  test('profiling stays if completeness < 80', () => {
    expect(evaluateStage({ engagement_stage: 'profiling', completeness_score: 50 }, 3)).toBe('profiling')
    expect(evaluateStage({ engagement_stage: 'profiling', completeness_score: 79 }, 3)).toBe('profiling')
    expect(evaluateStage({ engagement_stage: 'profiling', completeness_score: 0 }, 3)).toBe('profiling')
  })

  test('profiling advances to analyzing when completeness >= 80', () => {
    expect(evaluateStage({ engagement_stage: 'profiling', completeness_score: 80 }, 3)).toBe('analyzing')
    expect(evaluateStage({ engagement_stage: 'profiling', completeness_score: 100 }, 3)).toBe('analyzing')
  })

  test('reporting never auto-advances', () => {
    expect(evaluateStage({ engagement_stage: 'reporting', completeness_score: 100 }, 10)).toBe('reporting')
  })

  test('unknown stages stay unchanged', () => {
    expect(evaluateStage({ engagement_stage: 'unknown' }, 0)).toBe('unknown')
    expect(evaluateStage({ engagement_stage: 'unknown' }, 1)).toBe('unknown')
  })

  test('STAGES array contains all 4 stages', () => {
    expect(STAGES).toEqual(['onboarding', 'profiling', 'analyzing', 'reporting'])
  })
})
