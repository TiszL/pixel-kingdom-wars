use shardkeep_charter_interface::*;
const ID:Id=[0x12,0x34,0x56,0x78,0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0,0x12,0x34,0x56,0x78];
fn sale()->TransferCommitment { TransferCommitment {config:[1;32],transfer_config:[2;32],craft_program:[3;32],craft_control:[4;32],collection:[5;32],collection_authority:[6;32],charter:[7;32],asset:[8;32],asset_binding:[9;32],freeze_authority:[10;32],executor:[11;32],receipt:[12;32],seller:[13;32],buyer:[14;32],treasury:[15;32],clan_id:ID,transfer_id:ID,fence_id:ID,expected_revision:7,price_lamports:101,royalty_bps:500,terms_hash:[16;32]} }
#[test] fn sale_consent_binds_exact_economic_and_identity_bytes(){
 let v=sale();let mut expected=b"SKCHXFR1".to_vec();expected.extend(1u16.to_le_bytes());for i in 1..=15 {expected.extend([i;32]);}
 for _ in 0..3 {expected.extend(ID);}expected.extend(7u32.to_le_bytes());expected.extend(101u64.to_le_bytes());expected.extend(500u16.to_le_bytes());expected.extend([16;32]);
 assert_eq!(transfer_preimage(&v).unwrap(),expected);
 for i in 0..16 {let mut changed=v;let keys=[&mut changed.config,&mut changed.transfer_config,&mut changed.craft_program,&mut changed.craft_control,&mut changed.collection,&mut changed.collection_authority,&mut changed.charter,&mut changed.asset,&mut changed.asset_binding,&mut changed.freeze_authority,&mut changed.executor,&mut changed.receipt,&mut changed.seller,&mut changed.buyer,&mut changed.treasury,&mut changed.terms_hash];keys.into_iter().nth(i).unwrap().fill(0);assert!(transfer_preimage(&changed).is_err());}
 let mut changed=v;changed.fence_id[15]^=1;assert_ne!(transfer_preimage(&changed).unwrap(),expected);
 let mut changed=v;changed.price_lamports=0;assert!(transfer_preimage(&changed).is_err());
 let mut changed=v;changed.buyer=changed.seller;assert!(transfer_preimage(&changed).is_err());
}
#[test] fn lock_action_and_revision_cannot_be_reused_for_the_opposite_transition(){
 let v=LockCommitment {config:[1;32],charter:[2;32],asset:[3;32],leader:[4;32],clan_id:ID,lock_id:ID,expected_revision:17,action:1,terms_hash:[5;32]};
 let mut expected=b"SKCHLCK1".to_vec();expected.extend(1u16.to_le_bytes());for i in 1..=4 {expected.extend([i;32]);}expected.extend(ID);expected.extend(ID);expected.extend(17u32.to_le_bytes());expected.push(1);expected.extend([5;32]);
 assert_eq!(lock_preimage(&v).unwrap(),expected);let mut changed=v;changed.action=2;assert_ne!(lock_preimage(&changed).unwrap(),expected);changed.action=0;assert!(lock_preimage(&changed).is_err());changed=v;changed.expected_revision+=1;assert_ne!(lock_preimage(&changed).unwrap(),expected);changed.lock_id=[0;16];assert!(lock_preimage(&changed).is_err());
}
