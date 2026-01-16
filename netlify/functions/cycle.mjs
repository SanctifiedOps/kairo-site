import {runCycleJobs} from "../../server.js";

export const handler = async () => {
  try{
    await runCycleJobs();
    return {
      statusCode:200,
      body:"ok"
    };
  }catch(err){
    return {
      statusCode:500,
      body:"error"
    };
  }
};
