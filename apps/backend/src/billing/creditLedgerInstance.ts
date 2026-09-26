import path from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import { CreditLedger } from "./CreditLedger";

export const creditLedger = new CreditLedger(path.join(defaultDataDir(), "billing.sqlite"));
