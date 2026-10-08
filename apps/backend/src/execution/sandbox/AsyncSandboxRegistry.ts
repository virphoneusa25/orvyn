import {selectedStorage} from "../../persistence/PostgresRuntime";
import {asyncOperations,type AsyncOperations} from "../../auth/asyncOperations";
import {SandboxRegistry,sandboxRegistry as sqliteRegistry} from "./SandboxRegistry";
import {PostgresSandboxRegistry} from "./PostgresSandboxRegistry";
export type SandboxOperations=AsyncOperations<SandboxRegistry>;
let owner:Promise<PostgresSandboxRegistry>|undefined;
const service=asyncOperations<SandboxRegistry>(async()=>{
 if(process.env.ORVYN_POSTGRES_EXECUTION!=="1")return sqliteRegistry();
 const selected=selectedStorage();if(selected.mode!=="postgres")throw new Error("Execution PostgreSQL storage requires PostgreSQL primary");
 return owner??=PostgresSandboxRegistry.connect(selected.url);
});
export function sandboxRegistry(){return service;}
export * from "./SandboxRegistry";
