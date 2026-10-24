/** 当前 oma 前端构建对应的 commit 与提交日期（YYYY-MM-DD，取提交所在时区）；无法读取时为 null。 */
export const version = __OMA_VERSION__ && {
  commit: __OMA_VERSION__.commit,
  date: __OMA_VERSION__.date.slice(0, 10),
};
