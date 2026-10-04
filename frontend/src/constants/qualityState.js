// #172 条目质量状态的取值与中文标签。
//
// 三个取值必须与 backend/pb_migrations/1789200400_page_quality_state.js 的 STATES
// 逐字一致；frontend/tests/qualityState.test.js 会读那份迁移源码比对，所以这里是
// 有据可查的镜像，不是又一处手抄。
export const QUALITY_STATE = {
  CANDIDATE: 'candidate',
  VALIDATED: 'validated',
  WITHHELD: 'withheld'
}

export const QUALITY_STATES = [
  QUALITY_STATE.CANDIDATE,
  QUALITY_STATE.VALIDATED,
  QUALITY_STATE.WITHHELD
]

export const QUALITY_STATE_LABELS = {
  [QUALITY_STATE.CANDIDATE]: '待定',
  [QUALITY_STATE.VALIDATED]: '已确认',
  [QUALITY_STATE.WITHHELD]: '暂缓外发'
}

// 状态说明写在界面上，而不是要求使用者去读 issue：这三个值的区别是「能不能外发」，
// 不是进度。把它写成进度词会让管理员以为 withheld 是"还没校对完"。
export const QUALITY_STATE_HINTS = {
  [QUALITY_STATE.CANDIDATE]: '默认值。尚未明确进入当前可交付集合。',
  [QUALITY_STATE.VALIDATED]: '满足当前项目约定，可进入常规导出与 Review Bundle。',
  [QUALITY_STATE.WITHHELD]: '存在争议、权利未决或其他原因，默认不得外发。'
}
