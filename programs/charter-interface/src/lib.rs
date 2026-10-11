//! Fixed Charter wire views only: no account authority, hashing, SDK or program dependency.
//! Runtime owner/address/signer checks belong to the calling programs.

pub type Key = [u8; 32];
pub type Id = [u8; 16];
pub const VERSION: u8 = 1;
pub const FORMAT_VERSION: u16 = 1;
// D153.151/152: bounded technical metadata profile, not game tuning.
pub const MAX_NAME_BYTES: usize = 64;
pub const MAX_URI_BYTES: usize = 512;
pub const CONTROL_BYTES: usize = 141;
pub const CONFIG_BYTES: usize = 170;
pub const CHARTER_BYTES: usize = 280;
pub const ASSET_BINDING_BYTES: usize = 90;
pub const CREATION_RECEIPT_BYTES: usize = 154;
pub const REGISTRATION_PREIMAGE_BYTES: usize = 490;
pub const CONTROL_DISCRIMINATOR: [u8; 8] = [208,94,55,213,202,10,219,138];
pub const CONFIG_DISCRIMINATOR: [u8; 8] = [61,150,238,226,250,49,125,171];
pub const CHARTER_DISCRIMINATOR: [u8; 8] = [245,213,160,137,159,240,171,190];
pub const ASSET_BINDING_DISCRIMINATOR: [u8; 8] = [113,115,189,133,223,211,14,190];
pub const CREATION_RECEIPT_DISCRIMINATOR: [u8; 8] = [51,110,253,148,194,127,120,156];
pub const MINT_DISCRIMINATOR: [u8; 8] = [171,123,250,172,222,61,125,90];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError { Malformed, Unsupported, InvalidIdentity, InvalidMetadata }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CharterState { Minting, Active, Retired }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CharterLock { None, Tournament }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlView {
    pub version: u8, pub bootstrap_admin: Key, pub economy_program: Key,
    pub collection: Key, pub collection_authority: Key, pub admission_paused: bool,
    pub bump: u8, pub collection_bump: u8, pub authority_bump: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub version: u8, pub authority: Key, pub craft_program: Key, pub craft_control: Key,
    pub collection: Key, pub collection_authority: Key, pub bump: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CharterView {
    pub version: u8, pub config: Key, pub clan_id: Id, pub asset: Key, pub collection: Key,
    pub leader: Key, pub revision: u32, pub state: CharterState, pub lock: CharterLock,
    pub lock_id: Id, pub creation_intent_id: Id, pub metadata_hash: Key,
    pub admission_commitment: Key, pub creation_permit_id: Id, pub created_at: i64, pub bump: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssetBindingView {
    pub version: u8, pub asset: Key, pub clan_id: Id, pub charter: Key, pub bump: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreationReceiptView {
    pub version: u8, pub intent_id: Id, pub clan_id: Id, pub charter: Key,
    pub asset: Key, pub leader: Key, pub permit_id: Id, pub bump: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegistrationCommitment {
    pub config: Key, pub craft_program: Key, pub craft_control: Key, pub collection: Key,
    pub collection_authority: Key, pub charter: Key, pub asset: Key, pub asset_binding: Key,
    pub freeze_authority: Key, pub executor: Key, pub creation_receipt: Key,
    pub clan_id: Id, pub leader: Key, pub creation_intent_id: Id, pub metadata_hash: Key,
    pub admission_commitment: Key,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintArgs<'a> {
    pub clan_id: Id, pub creation_intent_id: Id, pub admission_commitment: Key,
    pub name: &'a str, pub uri: &'a str, pub creation_permit_id: Id,
}

pub fn validate_uuid(id: &Id) -> Result<(), WireError> {
    if !(1..=8).contains(&(id[6] >> 4)) || id[8] >> 6 != 2 { return Err(WireError::InvalidIdentity); }
    Ok(())
}
fn nonzero(key: &Key) -> Result<(), WireError> {
    if *key == [0;32] { return Err(WireError::InvalidIdentity); } Ok(())
}
pub fn validate_metadata(name: &str, uri: &str) -> Result<(), WireError> {
    if name.is_empty() || name.len()>MAX_NAME_BYTES || uri.is_empty() || uri.len()>MAX_URI_BYTES {
        return Err(WireError::InvalidMetadata);
    } Ok(())
}
pub fn decode_control(data: &[u8]) -> Result<ControlView, WireError> {
    let mut r=Cursor::account(data,CONTROL_DISCRIMINATOR,CONTROL_BYTES)?;
    let value=ControlView {version:VERSION,bootstrap_admin:r.key()?,economy_program:r.key()?,collection:r.key()?,
        collection_authority:r.key()?,admission_paused:match r.byte()? {0=>false,1=>true,_=>return Err(WireError::Malformed)},
        bump:r.byte()?,collection_bump:r.byte()?,authority_bump:r.byte()?};r.end()?;Ok(value)
}
pub fn decode_config(data: &[u8]) -> Result<ConfigView, WireError> {
    let mut r=Cursor::account(data,CONFIG_DISCRIMINATOR,CONFIG_BYTES)?;
    let value=ConfigView {version:VERSION,authority:r.key()?,craft_program:r.key()?,craft_control:r.key()?,
        collection:r.key()?,collection_authority:r.key()?,bump:r.byte()?};r.end()?;Ok(value)
}
pub fn decode_charter(data: &[u8]) -> Result<CharterView, WireError> {
    let mut r=Cursor::account(data,CHARTER_DISCRIMINATOR,CHARTER_BYTES)?;
    let value=CharterView {version:VERSION,config:r.key()?,clan_id:r.uuid()?,asset:r.key()?,collection:r.key()?,leader:r.key()?,
        revision:u32::from_le_bytes(r.array()?),state:match r.byte()? {0=>CharterState::Minting,1=>CharterState::Active,2=>CharterState::Retired,_=>return Err(WireError::Unsupported)},
        lock:match r.byte()? {0=>CharterLock::None,1=>CharterLock::Tournament,_=>return Err(WireError::Unsupported)},lock_id:r.array()?,
        creation_intent_id:r.uuid()?,metadata_hash:r.key()?,admission_commitment:r.key()?,creation_permit_id:r.array()?,
        created_at:i64::from_le_bytes(r.array()?),bump:r.byte()?};
    match value.lock {CharterLock::None if value.lock_id != [0;16] => return Err(WireError::Unsupported), CharterLock::Tournament => {validate_uuid(&value.lock_id)?;}, _=>{}}
    if value.state==CharterState::Minting && (value.revision!=0 || value.lock!=CharterLock::None) {return Err(WireError::Unsupported);}
    if value.state==CharterState::Retired && (value.revision==0 || value.lock!=CharterLock::None) {return Err(WireError::Unsupported);}
    r.end()?;Ok(value)
}
pub fn decode_asset_binding(data: &[u8]) -> Result<AssetBindingView, WireError> {
    let mut r=Cursor::account(data,ASSET_BINDING_DISCRIMINATOR,ASSET_BINDING_BYTES)?;
    let value=AssetBindingView {version:VERSION,asset:r.key()?,clan_id:r.uuid()?,charter:r.key()?,bump:r.byte()?};r.end()?;Ok(value)
}
pub fn decode_creation_receipt(data: &[u8]) -> Result<CreationReceiptView, WireError> {
    let mut r=Cursor::account(data,CREATION_RECEIPT_DISCRIMINATOR,CREATION_RECEIPT_BYTES)?;
    let value=CreationReceiptView {version:VERSION,intent_id:r.uuid()?,clan_id:r.uuid()?,charter:r.key()?,asset:r.key()?,
        leader:r.key()?,permit_id:r.array()?,bump:r.byte()?};r.end()?;Ok(value)
}
pub fn metadata_preimage(name: &str, uri: &str) -> Result<Vec<u8>, WireError> {
    validate_metadata(name,uri)?;
    let mut b=Vec::with_capacity(16+name.len()+uri.len());b.extend_from_slice(b"SKCHMET1");
    string(&mut b,name);string(&mut b,uri);Ok(b)
}
pub fn registration_preimage(v: &RegistrationCommitment) -> Result<[u8; REGISTRATION_PREIMAGE_BYTES], WireError> {
    validate_uuid(&v.clan_id)?;validate_uuid(&v.creation_intent_id)?;
    let pins=[v.config,v.craft_program,v.craft_control,v.collection,v.collection_authority,v.charter,v.asset,
        v.asset_binding,v.freeze_authority,v.executor,v.creation_receipt];
    for key in pins.iter().chain([&v.leader,&v.metadata_hash,&v.admission_commitment]) {nonzero(key)?;}
    let mut b=Vec::with_capacity(REGISTRATION_PREIMAGE_BYTES);b.extend_from_slice(b"SKCHREG1");b.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    for pin in pins {b.extend_from_slice(&pin);}
    b.extend_from_slice(&v.clan_id);b.extend_from_slice(&v.leader);b.extend_from_slice(&v.creation_intent_id);
    b.extend_from_slice(&v.metadata_hash);b.extend_from_slice(&v.admission_commitment);
    b.try_into().map_err(|_|WireError::Malformed)
}
pub fn encode_mint(v: &MintArgs<'_>) -> Result<Vec<u8>, WireError> {
    validate_uuid(&v.clan_id)?;validate_uuid(&v.creation_intent_id)?;nonzero(&v.admission_commitment)?;validate_metadata(v.name,v.uri)?;
    let mut b=Vec::with_capacity(96+v.name.len()+v.uri.len());b.extend_from_slice(&MINT_DISCRIMINATOR);
    b.extend_from_slice(&v.clan_id);b.extend_from_slice(&v.creation_intent_id);b.extend_from_slice(&v.admission_commitment);
    string(&mut b,v.name);string(&mut b,v.uri);b.extend_from_slice(&v.creation_permit_id);Ok(b)
}
pub fn decode_mint(data: &[u8]) -> Result<MintArgs<'_>, WireError> {
    if data.len()>96+MAX_NAME_BYTES+MAX_URI_BYTES {return Err(WireError::InvalidMetadata);}
    let mut r=Cursor {data,at:0};if r.array::<8>()? != MINT_DISCRIMINATOR {return Err(WireError::Unsupported);}
    let value=MintArgs {clan_id:r.uuid()?,creation_intent_id:r.uuid()?,admission_commitment:r.key()?,
        name:r.string(MAX_NAME_BYTES)?,uri:r.string(MAX_URI_BYTES)?,creation_permit_id:r.array()?};r.end()?;Ok(value)
}
fn string(bytes:&mut Vec<u8>, value:&str) {
    // Only called after fixed metadata bounds have been checked.
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());bytes.extend_from_slice(value.as_bytes());
}
struct Cursor<'a> {data:&'a [u8],at:usize}
impl<'a> Cursor<'a> {
    fn account(data:&'a [u8],discriminator:[u8;8],size:usize)->Result<Self,WireError> {
        if data.len()!=size {return Err(WireError::Malformed);}
        let mut r=Self {data,at:0};
        if r.array::<8>()?!=discriminator || r.byte()?!=VERSION {return Err(WireError::Unsupported);}Ok(r)
    }
    fn take(&mut self,n:usize)->Result<&'a [u8],WireError> {
        let end=self.at.checked_add(n).ok_or(WireError::Malformed)?;
        let value=self.data.get(self.at..end).ok_or(WireError::Malformed)?;self.at=end;Ok(value)
    }
    fn array<const N:usize>(&mut self)->Result<[u8;N],WireError> {
        let mut value=[0;N];value.copy_from_slice(self.take(N)?);Ok(value)
    }
    fn byte(&mut self)->Result<u8,WireError> {Ok(self.array::<1>()?[0])}
    fn key(&mut self)->Result<Key,WireError> {let value=self.array()?;nonzero(&value)?;Ok(value)}
    fn uuid(&mut self)->Result<Id,WireError> {let value=self.array()?;validate_uuid(&value)?;Ok(value)}
    fn string(&mut self,max:usize)->Result<&'a str,WireError> {
        let size=usize::try_from(u32::from_le_bytes(self.array()?)).map_err(|_|WireError::InvalidMetadata)?;
        if size==0 || size>max {return Err(WireError::InvalidMetadata);}
        core::str::from_utf8(self.take(size)?).map_err(|_|WireError::InvalidMetadata)
    }
    fn end(&self)->Result<(),WireError> {if self.at!=self.data.len() {return Err(WireError::Malformed);}Ok(())}
}

// D153.175 exact consent for controlled transfers; no signer or backend authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferCommitment {
 pub config: Key, pub transfer_config: Key, pub craft_program: Key, pub craft_control: Key,
 pub collection: Key, pub collection_authority: Key, pub charter: Key, pub asset: Key,
 pub asset_binding: Key, pub freeze_authority: Key, pub executor: Key, pub receipt: Key,
 pub seller: Key, pub buyer: Key, pub treasury: Key,
 pub clan_id: Id, pub transfer_id: Id, pub fence_id: Id, pub expected_revision: u32,
 pub price_lamports: u64, pub royalty_bps:u16, pub terms_hash: Key,
}
pub fn transfer_preimage(v: &TransferCommitment) -> Result<Vec<u8>, WireError> {
 for id in [&v.clan_id,&v.transfer_id,&v.fence_id] {validate_uuid(id)?;}
 if v.price_lamports==0 || v.seller==v.buyer || v.treasury==v.seller || v.treasury==v.buyer {return Err(WireError::InvalidIdentity);}
 let mut b=b"SKCHXFR1".to_vec();b.extend(FORMAT_VERSION.to_le_bytes());
 for key in [&v.config,&v.transfer_config,&v.craft_program,&v.craft_control,&v.collection,&v.collection_authority,&v.charter,&v.asset,&v.asset_binding,&v.freeze_authority,&v.executor,&v.receipt,&v.seller,&v.buyer,&v.treasury] {nonzero(key)?;b.extend(key);}
 for id in [&v.clan_id,&v.transfer_id,&v.fence_id] {b.extend(id);}b.extend(v.expected_revision.to_le_bytes());b.extend(v.price_lamports.to_le_bytes());if v.royalty_bps==0 || v.royalty_bps>10000 {return Err(WireError::Unsupported);}b.extend(v.royalty_bps.to_le_bytes());nonzero(&v.terms_hash)?;b.extend(v.terms_hash);Ok(b)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockCommitment {
 pub config: Key, pub charter: Key, pub asset: Key, pub leader: Key, pub clan_id: Id,
 pub lock_id: Id, pub expected_revision: u32, pub action: u8, pub terms_hash: Key,
}
pub fn lock_preimage(v: &LockCommitment) -> Result<Vec<u8>, WireError> {
 validate_uuid(&v.clan_id)?;validate_uuid(&v.lock_id)?;if v.action!=1 && v.action!=2 {return Err(WireError::Unsupported);}
 let mut b=b"SKCHLCK1".to_vec();b.extend(FORMAT_VERSION.to_le_bytes());for key in [&v.config,&v.charter,&v.asset,&v.leader] {nonzero(key)?;b.extend(key);}
 b.extend(v.clan_id);b.extend(v.lock_id);b.extend(v.expected_revision.to_le_bytes());b.push(v.action);nonzero(&v.terms_hash)?;b.extend(v.terms_hash);Ok(b)
}

/// Purpose-bound terminal authority. The policy attests backend clearance;
/// these bytes do not make the program independently verify SQL liabilities.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetirementCommitment {
 pub config:Key,pub craft_program:Key,pub craft_control:Key,pub collection:Key,pub collection_authority:Key,
 pub charter:Key,pub asset:Key,pub asset_binding:Key,pub freeze_authority:Key,pub receipt:Key,pub leader:Key,
 pub clan_id:Id,pub retirement_id:Id,pub fence_id:Id,pub expected_revision:u32,pub clearance_hash:Key,
}
pub fn retirement_preimage(v:&RetirementCommitment)->Result<Vec<u8>,WireError> {
 for id in [&v.clan_id,&v.retirement_id,&v.fence_id] {validate_uuid(id)?;}
 let mut b=b"SKCHRET1".to_vec();b.extend(FORMAT_VERSION.to_le_bytes());
 for key in [&v.config,&v.craft_program,&v.craft_control,&v.collection,&v.collection_authority,&v.charter,
  &v.asset,&v.asset_binding,&v.freeze_authority,&v.receipt,&v.leader] {nonzero(key)?;b.extend(key);}
 for id in [&v.clan_id,&v.retirement_id,&v.fence_id] {b.extend(id);}
 b.extend(v.expected_revision.to_le_bytes());nonzero(&v.clearance_hash)?;b.extend(v.clearance_hash);Ok(b)
}

// Anchor global:execute_charter_transfer; checked against generated instruction in craft tests.
pub const EXECUTE_TRANSFER_DISCRIMINATOR:[u8;8]=[173,95,189,138,107,204,249,60];
pub fn encode_transfer(clan_id:Id,expected_revision:u32)->Result<Vec<u8>,WireError>{validate_uuid(&clan_id)?;let mut b=EXECUTE_TRANSFER_DISCRIMINATOR.to_vec();b.extend(clan_id);b.extend(expected_revision.to_le_bytes());Ok(b)}
