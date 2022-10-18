/* This is used to commit or cancel an edit - if untypedupdates is
not supplied or empty , then no changes are made except the unlock*/

exports = async function(namespace,_id,untypedUpdates){
  let rval = { commitSuccess: false }
  

  let postCommit;
    
    if(_id == undefined) {
      return rval;   
  }

  const utilityFunctions =  await context.functions.execute("utility_functions")
  const objSchema =  await context.functions.execute("getDocTypeSchemaInfo",namespace)

  const [databaseName,collectionName] = namespace.split('.');
    if(!databaseName || !collectionName) { return rval;}
    
    //TODO - verify we have permission to write to this
    const collection = context.services.get("mongodb-atlas").db(databaseName).collection(collectionName);
      
 
    let user = context.user;
    let email = user.data.email;
    
    //Cannot unlock it if it's not mine  
    let checkLock = { _id, __lockedby : email };

    // Convert everything to the correct Javascript/BSON type 
    // As it's all sent as strings from the form, 
    // also sanitises any Javascript injection
    let updates = {}
    
    
    let deletepulls = {}
    let arrayPaths = {} ; /* note any arrays we are editing*/
    
    
    if(untypedUpdates != null) {
      for( let field of Object.keys(untypedUpdates) )
      {
        let arrayPath = []
        
          // MongoDB doesn't have a way of removing array elements by position - and with multiple editing processes
          // That could cause a race condition anyway, normally we would remove by value
          // As we are explicitly locking we are going to first update them to "$$REMOVE" is we have any then $pull them
          // in a second unlocking update.
    
         if(untypedUpdates[field] == "$$REMOVE") {
          updates[field] = "$$REMOVE" //Explicity make it this string - maybe should be null though
          //Get the field name without the index and mark it as needing $$REMOVE's pulled
          const basename = field.split('.')[0]
          deletepulls[basename] = "$$REMOVE"
        } else 
        {
          let parts = field.split('.')
          let subobj = objSchema
          for(let part of parts) {
            //This could be field objectfield.member arrayfield.index or arrayfield.index.member
            //In the schema it's always field or field.0.member
            if(!isNaN(part) ) {
              arrayPaths[arrayPath.join(".")] = true; //Record we found an array
              //!isNaN == isNumber
              part='0';
            }
            arrayPath.push(part)
            subobj = subobj[part]
          }
          //Now based on that convert value and add to our new query
          let correctlyTypedValue = utilityFunctions.correctValueType(untypedUpdates[field],subobj)
          if(correctlyTypedValue == null) {
    
            console.error(`Bad Record Summitted - cannot convert ${field}`)
            
      
            //Check here and if we cannot cast the value sent to the correct data type
            //When inserting or updating - so they types yes in a numeric field for example
            //We should raise an error
            return rval;
          }
          updates[field] = correctlyTypedValue
        }
      }
      
      
    }

    let unlockRecord = { $unset : { __locked: 1, __lockedby: 1, __locktime: 1}};
    let sets = {$set: updates}
    let pulls = {$pull: deletepulls};
  
    try {
      
    //If we have any edits to arrays - we first, unfortunately need to ensure that in the document
    //Those are arrays as is we do {$set:{"a.0":1}} and a is not an array (i.e null) then we get {a:{"0":1}}
    //we push this down as a pipeline update usin the $ifNull expresssion
    
    //TODO - we can ignore this for an insert
    
    let arrayFields = Object.keys(arrayPaths);
    if(arrayFields.length > 0) {
      let ensureArray = {}
      //For each field, if it's null then set it to square brackets
      for( let arrayField of arrayFields) {
        ensureArray[arrayField] = { $ifNull : [ `\$${arrayField}`,[] ]}
      }
      //Now apply that updateOne

      const { matchedCount, modifiedCount }= await collection.updateOne(checkLock,[{$set:ensureArray}]);
     
    }
    
      if(Object.keys(deletepulls).length == 0 )
      {
      
        const setAndUnlock = { ...sets,...unlockRecord};
        postCommit = await collection.findOneAndUpdate(checkLock,setAndUnlock,{returnNewDocument: true});
        rval.commitSuccess = true;
        rval.currentDoc = postCommit;
      } else {
        await collection.updateOne(checkLock,sets,{returnNewDocument: true});
        const removeElementsAndUnlock = { ...pulls,...unlockRecord};
        postCommit = await collection.findOneAndUpdate(checkLock,removeElementsAndUnlock,{returnNewDocument: true});
        rval.commitSuccess = true;
        rval.currentDoc = postCommit;
      }
    } catch(e) {
      console.log(`Error in commitEdit: ${e}`);
      //We couldn't find it or we weren't editing it that's OK - maybe it was stolen
       postCommit = await collection.findOne({_id},{__locked:0,__lockedby:0,__locktime:0});
       rval.currentDoc = postCommit;
    } 
    return rval;

};