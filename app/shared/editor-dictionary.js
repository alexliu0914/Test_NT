// 編輯器的繁體中文字典（M2 W1）：以 BlockNote 0.56 內建的 zh-tw 為底，
// 斜線選單的名稱改成計畫書 FR-04 的用詞（標題 1～3、項目清單、編號清單、待辦清單、引言……），並加上頁面連結。
import { zhTW } from '@blocknote/core/locales';

const rename = {
  heading: '標題 1', heading_2: '標題 2', heading_3: '標題 3', paragraph: '內文',
  bullet_list: '項目清單', numbered_list: '編號清單', check_list: '待辦清單',
  quote: '引言', divider: '分隔線', code_block: '程式碼', table: '表格',
};
const extraAliases = {
  heading: ['標題1', 'h1'], heading_2: ['標題2', 'h2'], heading_3: ['標題3', 'h3'], paragraph: ['內文', '段落'],
  bullet_list: ['項目', '清單'], numbered_list: ['編號', '清單'], check_list: ['待辦', 'todo'], quote: ['引言', '引用'],
  code_block: ['程式碼'], table: ['表格'],
};

const subtext = {
  heading: '最大的標題', heading_2: '段落標題', heading_3: '小節標題', paragraph: '一般文字',
  bullet_list: '不編號的清單', numbered_list: '依序編號的清單', check_list: '可勾選的待辦事項',
  quote: '引用他人的話或摘錄', divider: '分隔上下內容的橫線', code_block: '保留格式的程式碼', table: '插入表格',
};
const slash = { ...zhTW.slash_menu };
for (const [k, title] of Object.entries(rename)) {
  slash[k] = { ...slash[k], title, subtext: subtext[k], aliases: [...new Set([...(slash[k].aliases || []), title, ...(extraAliases[k] || [])])] };
}
export const SLASH_TITLES = rename;
export const PAGE_LINK_TITLE = '頁面連結';
export const dictionary = { ...zhTW, slash_menu: slash };
