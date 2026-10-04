Suite https://github.com/Universal-Commerce-Protocol/conformance @ 016ecbc22240affdec4429a60d539bedd04ab51b; SDK https://github.com/Universal-Commerce-Protocol/python-sdk @ v2026-04-08-6

ok 28 · failed 29 · skipped 20 · total 77

| Archivo | Test | Resultado | Nota |
|---|---|---|---|
| ap2_test.py | test_ap2_mandate_completion | ok |  |
| binding_test.py | test_token_binding_completion | ok |  |
| business_logic_test.py | test_buyer_consent | failed | AssertionError: None is not true : Consent info missing |
| business_logic_test.py | test_buyer_info_persistence | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| business_logic_test.py | test_discount_flow | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| business_logic_test.py | test_fixed_amount_discount | skipped | Fixed discount code not configured in fixtures. |
| business_logic_test.py | test_multiple_discounts_accepted | skipped | Second valid discount code not configured in fixtures. |
| business_logic_test.py | test_multiple_discounts_one_rejected | failed | AssertionError: None is not true |
| business_logic_test.py | test_totals_calculation_on_create | ok |  |
| business_logic_test.py | test_totals_recalculation_on_update | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| card_credential_test.py | test_card_credential_payment | failed | AssertionError: Checkout status not 'completed': |
| checkout_lifecycle_test.py | test_cancel_checkout | ok |  |
| checkout_lifecycle_test.py | test_cannot_cancel_completed_checkout | ok |  |
| checkout_lifecycle_test.py | test_cannot_complete_canceled_checkout | ok |  |
| checkout_lifecycle_test.py | test_cannot_update_canceled_checkout | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| checkout_lifecycle_test.py | test_cannot_update_completed_checkout | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| checkout_lifecycle_test.py | test_complete_checkout | ok |  |
| checkout_lifecycle_test.py | test_complete_is_idempotent | failed | AssertionError: 200 == 200 : Should not be able to complete an already completed checkout. |
| checkout_lifecycle_test.py | test_create_checkout | ok |  |
| checkout_lifecycle_test.py | test_get_checkout | ok |  |
| checkout_lifecycle_test.py | test_repeated_cancel | ok |  |
| checkout_lifecycle_test.py | test_update_checkout | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| discount_test.py | test_allocations_sum_to_applied_amount | skipped | business does not advertise dev.ucp.shopping.discount; skipping |
| discount_test.py | test_client_applied_does_not_change_price | skipped | business does not advertise dev.ucp.shopping.discount; skipping |
| discount_test.py | test_code_matches_case_insensitively | skipped | business does not advertise dev.ucp.shopping.discount; skipping |
| discount_test.py | test_codes_replace_previous_set | skipped | business does not advertise dev.ucp.shopping.discount; skipping |
| discount_test.py | test_discount_total_is_negative | skipped | business does not advertise dev.ucp.shopping.discount; skipping |
| discount_test.py | test_empty_codes_removes_discount | skipped | business does not advertise dev.ucp.shopping.discount; skipping |
| fulfillment_structure_test.py | test_default_config_single_group_per_method | failed | AssertionError: 400 not found in [200, 201] : Expected status [200, 201], got 400. Resp: {"ucp":{"version":"2026-04-08","status":"error"},"messages":[{"type":"error","code":"invalid_request","content":"this store sells one product per checkout; send one line item","severity":"recoverable"}]} |
| fulfillment_structure_test.py | test_option_titles_distinguish_siblings | ok |  |
| fulfillment_test.py | test_dynamic_fulfillment | skipped | No dynamic fulfillment cases configured in fixtures (test_fixtures.dynamic_fulfillment). |
| fulfillment_test.py | test_free_shipping_for_specific_item | skipped | No free-shipping-eligible item SKU configured in fixtures. |
| fulfillment_test.py | test_free_shipping_on_expensive_order | skipped | No free-shipping subtotal threshold configured in fixtures. |
| fulfillment_test.py | test_fulfillment_flow | ok |  |
| fulfillment_test.py | test_known_customer_multiple_addresses_selection | skipped | Known customer with at least two stored addresses not configured. |
| fulfillment_test.py | test_known_customer_new_address | skipped | No known customer configured in fixtures. |
| fulfillment_test.py | test_known_customer_no_address | skipped | No known customer without stored addresses configured in fixtures. |
| fulfillment_test.py | test_known_customer_one_address | skipped | No known customer with stored addresses configured in fixtures. |
| fulfillment_test.py | test_known_user_existing_address_reuse | skipped | No known customer with stored addresses configured in fixtures. |
| fulfillment_test.py | test_unknown_customer_no_address | ok |  |
| idempotency_test.py | test_idempotency_cancel | ok |  |
| idempotency_test.py | test_idempotency_complete | failed | AssertionError: 200 not found in [409] : Expected status 409, got 200. Resp: {"ucp":{"version":"2026-04-08","status":"success","capabilities":{"dev.ucp.shopping.checkout":[{"version":"2026-04-08"}],"dev.ucp.shopping.fulfillment":[{"version":"2026-04-08"}],"com.agentpey.shopping.receipt":[{"version":… |
| idempotency_test.py | test_idempotency_create | failed | AssertionError: {'currency': 'CLP', 'expires_at': '2026-10-04T06:24:36.481Z', 'fulfillment': {'methods': [{'id': 'fm_1', 'type': 'shipping', 'line_item_ids': ['li_1'], 'destinations': [{'id': 'dest_1', 'street_address': 'Av. Irarrázaval 2401', 'address_locality': 'Ñuñoa', 'address_region': 'Región M… |
| idempotency_test.py | test_idempotency_update | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| invalid_input_test.py | test_invalid_adjustment_status | failed | AssertionError: 404 not found in [422] : Expected status 422, got 404. Resp: {"error":"NotFound","message":"no route for PUT /ucp/v1/orders/ord_mut2wkbsb09b37218e"} |
| invalid_input_test.py | test_malformed_adjustment_payload | failed | AssertionError: 404 not found in [422] : Expected status 422, got 404. Resp: {"error":"NotFound","message":"no route for PUT /ucp/v1/orders/ord_mut2wkfta02f2fac59"} |
| invalid_input_test.py | test_unknown_discount_code | ok |  |
| order_test.py | test_order_adjustments | failed | AssertionError: 404 not found in [200] : Expected status 200, got 404. Resp: {"error":"NotFound","message":"no route for PUT /ucp/v1/orders/ord_mut2wlp1a8ca952905"} |
| order_test.py | test_order_fulfillment_retrieval | failed | AssertionError: None != 'Envío coordinado por la tienda' : Expectation description mismatch |
| order_test.py | test_order_retrieval | ok |  |
| order_test.py | test_order_update | failed | AssertionError: 404 not found in [200] : Expected status 200, got 404. Resp: {"error":"NotFound","message":"no route for PUT /ucp/v1/orders/ord_mut2wm7j55198d698c"} |
| protocol_test.py | test_discovery | ok |  |
| protocol_test.py | test_discovery_urls | skipped | Schemas not yet published on remote ucp.dev domain |
| protocol_test.py | test_version_negotiation | failed | AssertionError: 201 not found in [422] : Expected status 422, got 201. Resp: {"ucp":{"version":"2026-04-08","status":"success","capabilities":{"dev.ucp.shopping.checkout":[{"version":"2026-04-08"}],"dev.ucp.shopping.fulfillment":[{"version":"2026-04-08"}],"com.agentpey.shopping.receipt":[{"version":… |
| simulation_url_security_test.py | test_simulation_endpoint_correct_secret | ok |  |
| simulation_url_security_test.py | test_simulation_endpoint_incorrect_secret | ok |  |
| simulation_url_security_test.py | test_simulation_endpoint_missing_header | ok |  |
| totals_test.py | test_additive_entries_non_negative | ok |  |
| totals_test.py | test_discount_entry_is_negative | skipped | Server emitted no discount entry; sign invariant not applicable. |
| totals_test.py | test_entries_have_type_and_amount | ok |  |
| totals_test.py | test_single_subtotal_entry | ok |  |
| totals_test.py | test_single_total_entry | ok |  |
| validation_test.py | test_complete_without_fulfillment | ok |  |
| validation_test.py | test_out_of_stock | ok |  |
| validation_test.py | test_payment_failure | ok |  |
| validation_test.py | test_product_not_found | failed | AssertionError: False is not true : Expected 'not found' in error messages |
| validation_test.py | test_structured_error_messages | ok |  |
| validation_test.py | test_update_inventory_validation | failed | AttributeError: 'NoneType' object has no attribute 'instruments' |
| webhook_structure_test.py | test_delivery_carries_standard_webhook_headers | failed | AssertionError: [] is not true : no order-event webhook delivered for the completed order (order.md: MUST send 'Order created' event) |
| webhook_structure_test.py | test_order_created_event_is_full_order_entity | failed | AssertionError: [] is not true : no order-event webhook delivered for the completed order (order.md: MUST send 'Order created' event) |
| webhook_structure_test.py | test_signature_covers_ucp_agent | failed | AssertionError: [] is not true : no order-event webhook delivered for the completed order (order.md: MUST send 'Order created' event) |
| webhook_structure_test.py | test_signed_delivery_carries_required_headers_and_digest | failed | AssertionError: [] is not true : no order-event webhook delivered for the completed order (order.md: MUST send 'Order created' event) |
| webhook_structure_test.py | test_transient_failure_retries_preserve_event_identity | failed | AssertionError: 0 not greater than or equal to 2 : failed webhook delivery was not retried (order.md: MUST retry failed webhook deliveries) |
| webhook_structure_test.py | test_update_event_is_full_order_entity | failed | AssertionError: [] is not true : no order-event webhook delivered for the completed order (order.md: MUST send 'Order created' event) |
| webhook_test.py | test_webhook_event_stream | failed | AssertionError: [] is not true : no order-event webhook delivered for the completed order |
| webhook_test.py | test_webhook_order_address_known_customer | skipped | No known customer with stored addresses configured in fixtures. |
| webhook_test.py | test_webhook_order_address_new_address | skipped | No known customer configured in fixtures. |
