import {adapterDefinitions} from './adapter-registry.mjs';

// This is the only translation layer between V1's declarative capability
// catalog and V2. It carries knowledge and evidence rules, never executor code.
export function buildV2AdapterPlan({v1Catalog} = {}) {
  if (v1Catalog?.mode !== 'catalog_only') throw Error('V1 catalog must be catalog_only');
  const definitions = adapterDefinitions();
  const bySource = new Map(definitions.flatMap(def => (def.sourceFamilies??[]).map(family => [family, def])));
  const sites = (v1Catalog.sites??[]).map(site => {
    const definition = bySource.get(site.familyId);
    if (!definition) return {origin:site.origin, familyId:site.familyId, adapterId:null, canaryReady:false, blockers:['unmapped_v1_family']};
    return {
      origin:site.origin, familyId:site.familyId, adapterId:definition.id,
      canaryReady:false, observeOnly:true, requiredEvidence:[...site.requiredEvidence],
      blockers:['v2_canary_disabled']
    };
  });
  return {
    schemaVersion:1, mode:'observe_only', source:'v1-capability-catalog',
    adapters:definitions.map(def => ({id:def.id, sourceFamilies:[...(def.sourceFamilies??[])], phase:def.phase, canaryReady:false})),
    sites, blockers:sites.flatMap(site => site.blockers.map(reason => ({origin:site.origin, reason})))
  };
}
