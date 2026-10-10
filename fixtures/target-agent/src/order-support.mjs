export class OrderContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrderContractError";
  }
}

export function getCustomerEmail(response) {
  return response.order.customer.email.toLowerCase();
}

export function resolveReceiptRequest(response) {
  return {
    status: "ready",
    orderId: response.order.id,
    recipient: getCustomerEmail(response),
  };
}
