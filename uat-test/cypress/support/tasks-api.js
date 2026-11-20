// GraphQL helpers for spec setup and cleanup that must not move the page under test:
// plain requests, plus the checker step of maker-checker (approving open tasks).
import { TIMEOUTS } from './constants';

export const gql = (query) => cy.request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
  .then(({ body }) => {
    if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  });

export const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

// Sends a mutation and waits until it is processed; fails unless it succeeded.
// Sends the mutation and yields its log once processed: { status, error }.
export const mutate = (name, input, label) => {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId, { timeout: TIMEOUTS.BACKEND_VALIDATION }));
};

export const mutateOk = (name, input, label) => mutate(name, input, label)
  .then(({ status, error }) => {
    if (status !== 2) throw new Error(`${label} failed: ${error}`);
  });

// Open tasks of an entity, optionally only those of one business event
// (e.g. "payroll.payroll_delete", not the "payroll.accept_payroll" of the same payroll).
export const pendingTasksOf = (entityId, { businessEvent } = {}) =>
  gql(`{ task(entityIds: ["${entityId}"], isDeleted: false) { edges { node { uuid status businessEvent } } } }`)
    .then((data) => data.task.edges.map((e) => e.node)
      .filter((t) => ['RECEIVED', 'ACCEPTED'].includes(t.status))
      .filter((t) => !businessEvent || t.businessEvent === businessEvent));

// Approves, as the checker (Admin, executor of the permissive group "any"), every open
// task on the entity (of `businessEvent` when given), then waits until none is left open.
// Does nothing when the update was applied directly (maker-checker off).
export function approvePendingTasksOf(entityId, { businessEvent } = {}) {
  pendingTasksOf(entityId, { businessEvent }).then((tasks) => {
    if (!tasks.length) return;
    // API only: the page under test must stay where it is (ensurePermissiveTaskGroup
    // navigates to the task groups page). The baseline creates the group "any".
    gql('{ taskGroup(code: "any", isDeleted: false) { edges { node { uuid } } } users(username: "Admin") { edges { node { id } } } }')
      .then((data) => {
        const group = data.taskGroup.edges[0]?.node;
        if (!group) throw new Error('Task group "any" is missing: run the UAT baseline');
        const groupUuid = group.uuid;
        const adminUuid = atob(data.users.edges[0].node.id).split(':')[1];
        const vote = JSON.stringify(JSON.stringify({ [adminUuid]: 'APPROVED' }));
        tasks.forEach((task) => {
          if (task.status === 'RECEIVED') {
            mutateOk('updateTask', `id: "${task.uuid}" status: ACCEPTED taskGroupId: "${groupUuid}"`, `UAT checker - accept task ${task.uuid}`);
          }
          mutateOk('resolveTask', `id: "${task.uuid}" businessStatus: ${vote}`, `UAT checker - approve task ${task.uuid}`);
        });
      });
    const waitClosed = (tries) => pendingTasksOf(entityId, { businessEvent }).then((open) => {
      if (!open.length) return;
      if (tries <= 0) throw new Error(`Tasks of ${entityId} still open after approval: ${JSON.stringify(open)}`);
      // eslint-disable-next-line cypress/no-unnecessary-waiting
      cy.wait(1000, { log: false }).then(() => waitClosed(tries - 1));
    });
    waitClosed(30);
  });
}
