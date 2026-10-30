const codes=new Set(['PT_CLEANUP_PENDING','PT_PREFLIGHT']);
const stages=new Set(['controller','pt_cleanup']);
export function gatewayError(error) {
  return {code:codes.has(error?.code)?error.code:'GATEWAY_CONTROLLER_FAILED',
    stage:stages.has(error?.gatewayStage)?error.gatewayStage:'controller'};
}
