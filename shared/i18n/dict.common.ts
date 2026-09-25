/** 扩展用到的通用文案（与服务端字典同源；服务端的错误分类不在这里） */
import type { Dict } from "./index.ts";

export const COMMON_DICT: Dict = {
  "common.cancel": ["Cancel", "取消", "キャンセル", "Отмена"],
  "common.daysAgo": [
    "{n} days ago",
    "{n} 天前",
    "{n} 日前",
    "{n} дн назад",
  ],
  "common.delete": ["Delete", "删除", "削除", "Удалить"],
  "common.disabled": ["Disabled", "停用", "無効", "Отключено"],
  "common.edit": ["Edit", "编辑", "編集", "Изменить"],
  "common.enabled": ["Enabled", "启用", "有効", "Включено"],
  "common.hoursAgo": ["{n} hours ago", "{n} 小时前", "{n} 時間前", "{n} ч назад"],
  "common.justNow": ["Just now", "刚刚", "たった今", "Только что"],
  "common.language": ["Language", "语言", "言語", "Язык"],
  "common.loading": ["Loading…", "载入中…", "読み込み中…", "Загрузка…"],
  "common.minutesAgo": [
    "{n} minutes ago",
    "{n} 分钟前",
    "{n} 分前",
    "{n} мин назад",
  ],
  "common.networkError": [
    "Network error: {message}",
    "网络错误：{message}",
    "ネットワークエラー：{message}",
    "Ошибка сети: {message}",
  ],
  "common.never": ["Never", "从未", "なし", "Никогда"],
  "common.none": ["None", "无", "なし", "Нет"],
  "common.save": ["Save", "保存", "保存", "Сохранить"],
  "common.saving": ["Saving…", "保存中…", "保存中…", "Сохранение…"],
  "common.tagline": [
    "Shared blocklists for X",
    "共享的 X 过滤列表",
    "X の共有ブロックリスト",
    "Общие блок-листы для X",
  ],
  "common.thresholdPosts": [
    "Needs {n}+ posts",
    "需 {n} 条以上帖文",
    "{n} 件以上が必要",
    "Нужно {n}+ публикаций",
  ],
  "list.entries": ["{n} entries", "{n} 条目", "{n} 件", "{n} записей"],
  "list.subscribers": [
    "{n} active readers",
    "{n} 位活跃读者",
    "{n} 人のアクティブ読者",
    "{n} активных читателей",
  ],
};
