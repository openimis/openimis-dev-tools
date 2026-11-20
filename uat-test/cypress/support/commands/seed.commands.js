// Seeds reference data through the GraphQL API (the same mutations the UI sends),
// for UAT flows that need data the demo dataset does not ship.

const uuidv4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

// Relay ids are base64("TypeName:pk").
const decodeId = (relayId) => +atob(relayId).split(':')[1];

function gql(query) {
  return cy
    .request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
    .then(({ body }) => {
      if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
      return body.data;
    });
}

function mutate(name, input, label) {
  const clientMutationId = uuidv4();
  return gql(
    `mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`,
  )
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then(({ status, error }) => {
      if (status !== 2) throw new Error(`${label} failed: ${error}`);
    });
}

export function registerSeedCommands() {
  // Creates a package ("P") medical service made of existing items and adds it to
  // the services price list of a health facility, so the claim service picker
  // offers it. Yields the service code.
  Cypress.Commands.add('seedComplexService', ({ code, name, items, hfCode }) => {
    const idByCode = {};
    items.forEach((i) => {
      gql(`{ medicalItems(code: "${i.code}") { edges { node { id } } } }`).then((data) => {
        const node = data.medicalItems.edges[0]?.node;
        if (!node) throw new Error(`seedComplexService: unknown item ${i.code}`);
        idByCode[i.code] = decodeId(node.id);
      });
    });
    cy.then(() => {
      const itemInputs = items
        .map((i) => `{ itemId: ${idByCode[i.code]} qtyProvided: "${i.qty}" priceAsked: "0" status: 1 }`)
        .join(' ');
      mutate(
        'createService',
        `code: "${code}" name: "${name}" type: "C" careType: "B" patientCategory: 15 price: "100"
         level: "S" category: "O" packagetype: "P" manualPrice: "0" items: [${itemInputs}]`,
        `UAT seed - complex service ${code}`,
      );
    });

    gql(`{ medicalServices(code: "${code}") { edges { node { uuid } } } }`).then((services) => {
      const serviceUuid = services.medicalServices.edges[0]?.node.uuid;
      if (!serviceUuid) throw new Error(`seedComplexService: service ${code} not found after creation`);
      gql(
        `{ healthFacilities(code: "${hfCode}") { edges { node { servicesPricelist { uuid name pricelistDate location { uuid } } } } } }`,
      ).then((hfs) => {
        const pricelist = hfs.healthFacilities.edges[0]?.node.servicesPricelist;
        if (!pricelist) throw new Error(`seedComplexService: health facility ${hfCode} has no services price list`);
        mutate(
          'updateServicesPricelist',
          `uuid: "${pricelist.uuid}" name: "${pricelist.name}" pricelistDate: "${pricelist.pricelistDate}"
           ${pricelist.location ? `locationId: "${pricelist.location.uuid}"` : ''} addedDetails: ["${serviceUuid}"]`,
          `UAT seed - add ${code} to ${pricelist.name}`,
        );
      });
    });
    cy.wrap(code);
  });
}
