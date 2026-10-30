const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const resumeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** メッセージの作成時刻（日本時間） */
export const formatMessageTime = (iso: string) => timeFormatter.format(new Date(iso));

/** コード再送の再開時刻など（JST基準で表示） */
export const formatResumeTime = (iso: string) => `${resumeFormatter.format(new Date(iso))}（日本時間）`;
