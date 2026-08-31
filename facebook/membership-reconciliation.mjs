import { assertExactCommunityJoinAuthorization } from './join-policy.mjs';
import { FACEBOOK_MEMBERSHIP_VERIFIER_VERSION } from './membership-verifier.mjs';

export class FacebookMembershipReconciliationService {
  constructor({ registry, verifier } = {}) { if (!registry || !verifier) throw new TypeError('registry and verifier are required'); this.registry = registry; this.verifier = verifier; }
  async reconcile() {
    const candidates = this.registry.listFacebookMembershipReconciliationCandidates();
    const results = [];
    for (const item of candidates) {
      const authorization = assertExactCommunityJoinAuthorization(item);
      const observed = await this.verifier.verify({ authorization });
      const persisted = this.registry.recordFacebookMembershipVerification({ communityId: item.community.id, joinExecutionId: item.execution.id, verifierVersion: FACEBOOK_MEMBERSHIP_VERIFIER_VERSION, finalState: observed.finalState, reason: observed.reason, evidence: observed.evidence });
      results.push({ communityId:item.community.id,community:item.community.name,previousState:persisted.previousState,verificationEvidence:observed.evidence,finalState:persisted.finalState,monitoringEligible:persisted.finalState==='JOINED_CONFIRMED',lifecycleCorrected:persisted.lifecycleCorrected });
    }
    return { reconciled:results.length,newJoinClicks:0,monitoringReady:results.filter(item=>item.monitoringEligible).length,states:Object.fromEntries([...new Set(results.map(item=>item.finalState))].map(state=>[state,results.filter(item=>item.finalState===state).length])),results };
  }
}
