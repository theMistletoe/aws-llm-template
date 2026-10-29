/** 結合テスト用のポート・テーブル（開発用の local プロファイルとは分離） */
export const AGENT_PORT = 18080;
export const API_PORT = 13000;
/** クォータを小さくした別インスタンス */
export const LIMITED_API_PORT = 13001;
export const API = `http://127.0.0.1:${API_PORT}`;
export const LIMITED_API = `http://127.0.0.1:${LIMITED_API_PORT}`;
export const ORIGIN = 'http://localhost:5173';
export const TABLES = { data: 'chat-app-test-data', session: 'chat-app-test-session' };

export const API_ENV = {
  APP_ORIGIN: ORIGIN,
  DATA_TABLE_NAME: TABLES.data,
  SESSION_TABLE_NAME: TABLES.session,
  LOCAL_AGENT_URL: `http://127.0.0.1:${AGENT_PORT}`,
  HEARTBEAT_INTERVAL_MS: '300',
};

export const LIMITED_API_ENV = {
  ...API_ENV,
  QUOTA_DAILY_REQUESTS: '3',
  QUOTA_HOURLY_REQUESTS: '2',
  QUOTA_DAILY_SEARCHES: '1',
};
