import auth from "./commands/google/account/auth.ts";
import accountGet from "./commands/google/account/get.ts";
import accountList from "./commands/google/account/list.ts";

export default [accountList, accountGet, auth];
