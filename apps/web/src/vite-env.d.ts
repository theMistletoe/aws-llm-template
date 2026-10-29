/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Function URL + OAC 構成の場合のみ "true"。POST/PUT/PATCH のボディハッシュを付与する（§9.4） */
  readonly VITE_PAYLOAD_HASH_HEADER?: string;
}
