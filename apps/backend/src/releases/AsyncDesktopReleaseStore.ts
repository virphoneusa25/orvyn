import {selectedStorage} from "../persistence/PostgresRuntime";
import {asyncOperations} from "../auth/asyncOperations";
import {DesktopReleaseStore,desktopReleaseStore as sqliteStore} from "./desktopReleaseStore";
import {PostgresDesktopReleaseStore} from "./PostgresDesktopReleaseStore";
export * from "./desktopReleaseStore";
let owner:Promise<PostgresDesktopReleaseStore>|undefined;
const service=asyncOperations<DesktopReleaseStore>(async()=>{
 if(process.env.ORVYN_POSTGRES_DESKTOP_RELEASES!=="1")return sqliteStore();
 const selected=selectedStorage();if(selected.mode!=="postgres")throw new Error("Desktop PostgreSQL storage requires PostgreSQL primary");
 return owner??=PostgresDesktopReleaseStore.connect(selected.url);
});
export function desktopReleaseStore(){return service;}
