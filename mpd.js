/**
 * Main interface and only global varialbe of the MPD.js library.
 * This function returns an object representing an MPD web client.
 * All other methods documented here are member functions of the object returned by a call to the MPD function.
 *
 * @example
 * //retrives a MPD client interface on port 8800
 * var mpd_client = MPD(8800);
 * //set handler for when the state changes
 * mpd_client.on('StateChanged', updateUiFunction);
 * @param {int} [port_number]
 * @function MPD
 * @module
 */
function MPD(_port){

    /**
     * Object representation of a song. This is a direct translation of the data that MPD returns, if MPD does not think a particular
     * song should have a property it won't return one. What is documented here are the properties I have seen MPD return, not all of
     * these will be returned all of the time. The properties file, date, and time appear to be consistently returned, but MPD makes
     * no promises. All other properties I frequently find missing, you will need to check to make sure they are present before using.
     * @typedef {Object} song
     * @property {String} file - the full path to the music file in MPD's music directory. relative path.
     * @property {Date} last_modified - last time the file was altered
     * @property {Int} time - duration of song in seconds
     * @property {String=} artist - optional metadata
     * @property {String=} title - optional metadata
     * @property {String=} album - optional metadata
     * @property {String=} track - optional metadata
     * @property {String=} genre - optional metadata
     * @property {String=} disk - optional metadata
     */

     /**
      * A song that is on the queue, has all of the same properties of a song, but with additional properties
      * @typedef {Object} queue_song
      * @see song
      * @extends song
      * @property {Int} id - a persistent identifer for this song on the queue, is only relevent to the queue, is not associated with the song it's self
      * @property {Int} pos - the position of the song on the queue. the queue index.
      */

     /**
      * Object representation of a directory. Directories are representations of folders that contain other folders and songs, they
      * map to directories on the MPD server's machine. This appears to be a fairly stable structure returned by MPD.
      * @typedef {Object} directory
      * @property {String} directory - file path relative to MPD's music folders
      * @property {Date} last_modified - last time this directory was modified
      */


    /****************\
    |* private data *|
    \****************/

    var MPD = {
      /**
       * THE web socket that is connected to the MPD server
       * @private
       */
      socket:null,

      /**
       * object {string:[function]} -- listing of funcitons to call when certain events happen
       *
       * valid handlers:
       * Connect
       * Disconnect
       * Queue
       * State
       * SongChange
       * Mpdhost
       * Error
       * @private
       */
      handlers:{},

      /**
       * basically the same as above, but private and imutable and it's just a single function
       * called before the external handlers so they can screw with the event if they want
       * @private
       */
      internal_handlers:{
        onConnect:onConnect,
        onDisconnect:onDisconnect,
        onStateChanged:onStateChanged,
        onQueueChanged:onQueueChanged,
        onPlaylistsChanged:onPlaylistsChanged,
        onPlaylistChanged:onPlaylistChanged
      },

      /**
       * number -- int number of milisecond to wait until reconnecting after loosing connection
       * set to something falsyto disable automatic reconnection
       * @private
       */
      reconnect_time: 3000,

      /**
       * true if we want logging turned on
       * @private
       */
      do_logging: true,

      /**
       * Our understanding of what the server looks like
       * @typedef {Object} state
       * @property {String} version - server protocol version
       * @property {boolean} connected - if we are currently connected to the server or not
       * @property {string} playstate - enum, PLAYING, STOPPED, PAUSED
       * actual MPD attribute: state (int 0,1,2)
       * @property {int} volume - 0 to 1 the current volume
       * @property {boolean} repeat - true if the server is configured to repeat the current song
       * @property {boolean} single - true if the server is configured to just play one song then quit
       * @property {boolean} consume - true if the server is configured to not repeat songs in a playlist
       * @property {boolean} random - true if the server is configured to play music in a random order
       * @property {float} mix_ramp_threshold - not sure what this is, but it's reported
       * actual MPD attribute: mixrampdb
       * @property {Object} current_song - info about the currently playing song
       * @property {int} current_song.queue_idx - which song in the current playlist is active
       * actual MPD attribute: song
       * @property {float} current_song.elapsed_time - time into the currently playing song in seconds
       * actual MPD attribute: elapsed
       * @property {int} current_song.id - the id of the current song
       * actual MPD attribute: songid
       * @property {Object} next_song - info about the song next to play on the queue
       * @property {int} next_song.queue_idx - which song in the current playlist is active
       * actual attribute: song
       * @property {int} next_song.id - the id of the current song
       * actual attribute: songid
       * @property {queue_song[]} current_queue - the songs that are currently in rotation for playing, in the order they are to play (unless random is set to true)
       * @property {int} queue_version - a number associated with the queue that changes every time the queue changes
       * @property {String[]} playlists - names of all of the saved playlists
       */
      state:{
          version: null,
          connected:false,
          playstate: null,
          volume: null,
          repeat: null,
          single: null,
          consume: null,
          random: null,
          mix_ramp_threshold: null,
          current_song: {
              queue_idx: null,
              elapsed_time: null,
               id: null
          },

          next_song: {
              queue_idx: null,
               id: null
          },
          current_queue:[],
          queue_version: null,
          playlists:[]

      },

      /**
       * valid tag values
       * null here means it's an open ended tag
       * @private
       */
      tag_values:{
          any:null,
          artist:[],
          album:[],
          albumartist:[],
          title:null,
          track:null,
          name:[],
          genre:[],
          date:null,
          composer:[],
          performer:[],
          comment:[],
          disc:[]
      },

      /**
       * when was the status last updated
       * @private
       */
      last_status_update_time: new Date(),

      /**
       * current processing method
       * called when ever we get some sort of responce
       * this gets changed as our expected responces changed
       * accepts an array WHICH IT WILL CHANGE eventually,
       * when the lines have comprised a complete command
       * this method may change it's self, so after calling this method,
       * this reference might point to a different method
       * defaults to do nothing
       *
       * understanding this variable is essential for understanding how this package works
       * this is basically a changable behaviour method
       * @private
       */
      responceProcessor:function(lines){}
    };

    /*******************\
    |* private methods *|
    \*******************/

    /**
     * logging function
     * @private
     */
    function log(message){
      if(MPD.do_logging){
        console.log("MPD Client: "+message);
      }
    }

    /**
     * wrapper for sending a message to the server, allows logging
     * @private
     */
    function sendString(str){
        log('sending: "'+str+'"');
        MPD.socket.send_string(str);
    }


    /**
     * initalization funciton
     * called near the end of this file and when we need to reconnect
     * @private
     */
    function init(){
      var websocket_url = getAppropriateWsUrl();
      var websocket = new Websock();
      websocket.open(websocket_url);

      //these can throw
      websocket.on(
          'open',
          function(){
              callHandler('Connect', arguments);
          }
      );
      websocket.on('message', onRawData);
      websocket.on(
          'close',
          function(){
              callHandler('Disconnect', arguments);
          }
      );
      MPD.socket = websocket;
    }


    /**
     * issue a command to the server
     * this assumes we are starting in and wish to return to an idle state
     * @private
     */
    function issueCommand(command){
        if(!issueCommand.command){
            issueCommand.command = command+'\n';

            setTimeout(function(){
                sendString('noidle\n'+issueCommand.command+'idle\n');
                delete issueCommand.command;
            },50);
        }
        else{
            //append additional commands
            issueCommand.command += command+'\n';
        }
    }


    /**
     * private method that gets the right websocket URL
     * @private
     */
    function getAppropriateWsUrl()
    {
      var protocol = '';
      var url = document.URL;

      /*
      /* We open the websocket encrypted if this page came on an
      /* https:// url itself, otherwise unencrypted
      /*/

      //figure out protocol to use
      if (url.substring(0, 5) == "https") {
          protocol = "wss://";
          url = url.substr(8);
      } else {
          protocol = "ws://";
          if (url.substring(0, 4) == "http")
              url = url.substr(7);
      }

      //change the url so it points to the root
      url = protocol+(url.split('/')[0]);

      if(_port){
        //use the port this client was initialized with
        url = url.replace(/:\d*$/,'')+':'+_port;
      }

      return url;
    }


    /**
     * converts an string to a Date
     * @private
     */
    function parseDate(source){
        var value = null;
        var matches = null;
        if(matches = source.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/)){
            value = new Date();
            value.setFullYear(parseInt(matches[1],10));
            value.setMonth(parseInt(matches[2],10)-1);
            value.setDate(parseInt(matches[3],10));
            value.setHours(parseInt(matches[4],10));
            value.setMinutes(parseInt(matches[5],10));
            value.setSeconds(parseInt(matches[6],10));
        }
        return value;
    }


    /***************************\
    |* internal event handlers *|
    \***************************/


    /**
     * function called when the websocke connects
     * @private
     */
    function onConnect(){
      log("connected");
      MPD.state.connected = true;
      MPD.responceProcessor = handleConnectionMessage;
    }


    /**
     * called when we disconnected (unexpectedly)
     * @private
     */
    function onDisconnect(){
      log("disconnected");

      MPD.state.connected = false;
      MPD.socket = null;
      MPD.state.version = null;

      if(MPD.reconnect_time){
        setTimeout(init, MPD.reconnect_time);
      }

      MPD.responceProcessor = function(){};//do nothing
    }


    /**
     * the queue changed, this is the new queue
     * @private
     */
    function onQueueChanged(event){
      MPD.state.current_queue = event;
    }


    /**
     * called when we have some data,
     * might be a message,
     * might be a fragment of a message,
     * might be multiple messages
     * @private
     */
    function onRawData(){
        if(typeof onRawData.buffer === 'undefined'){
            onRawData.buffer = '';
            onRawData.lines = [];
        }
        onRawData.buffer += MPD.socket.rQshiftStr();
        var lines = onRawData.buffer.split('\n');
        onRawData.buffer = lines.pop(); //last line is incomplete
        onRawData.lines = onRawData.lines.concat(lines);

        lines.forEach(function(str){log('recived: "'+str+'"');});

        //keep processing untill we can't process any more
        var old_lines;
        while(onRawData.lines.length && old_lines != onRawData.lines.length){
            old_lines = onRawData.lines.length;
            MPD.responceProcessor(onRawData.lines);
        }
    }


    /**
     * the MPD server's state changed in some way
     * this handler mainly mangles the raw data to be in a format I like better
     * because of course I know better than the MPD maintainer what things should be called and the ranges things should be in
     * @private
     */
    function onStateChanged(event){
        log('state');

        MPD.last_status_update_time = new Date();

        //normalize some of the event properties because I don't like them the way they are
        event.current_song = {
            queue_idx: event.song,
            elapsed_time: event.elapsed,
            id: event.songid
        };
        delete event.song;
        delete event.elapsed;
        delete event.songid;

        event.mix_ramp_threshold = event.mixrampdb;
        event.playstate = event.state;
        event.queue_version = event.playlist;
        delete event.mixrampdb;
        delete event.state;
        delete event.playlist;

        event.next_song = {
            queue_idx: event.nextsong,
            id: event.nextsongid
        };
        delete event.nextsong;
        delete event.nextsongid;

        event.volume /= 100;

        for(property in event){
            MPD.state[property] = event[property];
        }
    }


    /**
     * queue has changed, this is the new one
     * @private
     */
    function onQueue(event){
        MPD.state.current_queue = event;
    }


    /**
     * the list of playlists has changed
     * @private
     */
    function onPlaylistsChanged(event){
        MPD.state.playlists = event;
    }


    /**
     * the list of playlist has changed
     * @private
     */
    function onPlaylistChanged(event){
        MPD.state.playlists[event.idx].songs = event.songs;
    }


    /**
     * call all event handlers for the specified event
     * @private
     */
    function callHandler(event_name, args){
        var handler_name = 'on'+event_name;

        if(MPD.internal_handlers[handler_name]){
            MPD.internal_handlers[handler_name](args);
        }

        if(!MPD.handlers[handler_name]){
            handler_name = 'onUnhandledEvent';
        }

        if(MPD.handlers[handler_name]){
            MPD.handlers[handler_name].forEach(function(func){
                try{
                    func(args, MPD.state, this);
                }
                catch(err){
                    dealWithError(err);
                }
            });
        }

        if(event_name !== 'Event'){
            callHandler('Event', {type:event_name, data:event.data});
        }
    }


    /**
     * add an event handler
     * @private
     */
    function on(event_name, handler){

        var acceptable_handlers = ['Error', 'Event', 'UnhandledEvent', 'DatabaseChanging', 'DataLoaded', 'StateChanged', 'QueueChanged', 'PlaylistsChanged', 'PlaylistChanged','Connect', 'Disconnect'];

        if(acceptable_handlers.indexOf(event_name) === -1){
            throw new Error("'"+event_name+"' is not a supported event");
        }


        //bind the passed method to the client interface
        handler = handler.bind(this);

        var handler_name = 'on'+event_name;
        if(MPD.handlers[handler_name]){
            MPD.handlers[handler_name].push(handler);
        }
        else{
            MPD.handlers[handler_name] = [handler];
        }
    }

    /*************************************\
    |* process responces from the server *|
    |*          generates events         *|
    \*************************************/


    /**
     * we got some sort of error message from the server
     * @private
     */
    function dealWithError(line){
        debugger;
        callHandler('Error', line);
        log('***ERROR*** '+line);
    }


    /**
     * return all of the lines upto one that matches the passed line
     * MUTATES lines
     * @private
     */
    function getLines(lines, last_line){
        var end_line = -1;
        for(var i = 0; i<lines.length; i++){
            var line = lines[i];
            if(line === last_line){
                end_line = i;
                break;
            }
            if(line.indexOf('ACK') === 0){
                dealWithError(line);
                lines.splice(i,1);
                i--;
            }
        }

        if(end_line === -1){
            return null;
        }
        return lines.splice(0, end_line+1);
    }


    /**
     * generic responce handler
     * deals with a responce that is a list of some sort of datastructure repeated over and over
     * @private
     */
    function processListResponce(lines){
        var output = [];
        var current_thing = null;
        var starting_key = null; //the key that starts off an object
        //so, we get an undiferentiated stream of key/value pairs
        lines.forEach(function(line){
            if(!current_thing){
                current_thing = {};
            }
            var key = line.replace(/([^:]+): (.*)/,'$1');
            var value = line.replace(/([^:]+): (.*)/,'$2');
            var date = null;
            if(value.length>0){
                if(value.match(/^\d*(\.\d*)?$/)){
                    value = parseFloat(value);
                }
                else if(date = parseDate(value)){
                    value = date;
                }
            }
            key = key.toLowerCase();
            key = key.replace(/[^\w\d]+/g, '_');

            //we are starting a new object
            if(key === starting_key){
                output.push(current_thing);
                current_thing = {};
            }
            current_thing[key] = value;

            //we want to skip the first, starting key so this is down here
            if(starting_key === null){
                starting_key = key;
            }

        });

        //get the last one
        if(current_thing){
            output.push(current_thing);
        }

        return output;
    }


    /**
     * generic handler for loading a list of records in a responce
     * @private
     */
    function getlistHandler(onDone, event_type, transformFunction){
        return function(lines){
            var message_lines = getLines(lines, 'OK');
            if(message_lines === null){
                return; //we got an incomplete list, bail wait for the rest of it
            }
            message_lines.pop();//get rid of the 'OK' line
            if(message_lines.length > 0){
                var list = processListResponce(message_lines);
                //optional transformation function
                if(transformFunction){
                    list = transformFunction(list);
                }
                //we have an event!
                if(event_type){
                    callHandler(event_type,list);
                }
                onDone(list);
            }
            else{
                if(event_type){
                    callHandler(event_type,[]);
                }
                onDone([]);
            }
        };
    }

    /**
     * given a change key, return the command that will result in getting the changed data
     * @private
     */
    function figureOutWhatToReload(change, actions){
        switch(change){
            case 'database': //the song database has been modified after update.
                //reload
                //everything
                actions.everything = true;
            break;

            case 'stored_playlist': //a stored playlist has been modified, renamed, created or deleted
                actions.playlist = true;
            break;

            case 'playlist': //the current playlist has been modified
                actions.queue = true;
            break;

            /*these are all status changed*/
            case 'player': //the player has been started, stopped or seeked
            case 'mixer': //the volume has been changed
            case 'output': //an audio output has been enabled or disabled
            case 'options': //options like repeat, random, crossfade, replay gain
                actions.status = true;
            break;

            /*these are things I'm not interested in (yet)*/
            case 'update': //a database update has started or finished. If the database was modified during the update, the database event is also emitted.
                //we don't want to do anything, but the front end might be interested in knowing about it
                callHandler('DatabaseChanging');
            case 'sticker': //the sticker database has been modified.
            case 'subscription': //a client has subscribed or unsubscribed to a channel
            case 'message': //a message was received on a channel this client is subscribed to; this event is only emitted when the queue is empty
            default:
                //default do nothing
        }
    }

    /**
     * wait for something to change
     * this is the state we spend most of out time in
     * @private
     */
    function idleHandler(lines){
        var message_lines = getLines(lines, 'OK');
        message_lines.pop();//get rid of the 'OK' line
        if(message_lines.length > 0){
            var actions = {};
            message_lines.forEach(function(line){
                var change = line.replace(/([^:]+): (.*)/,'$2');
                figureOutWhatToReload(change, actions);
            });

            if(actions.everything){
                //don't even bother doing anything fancy
                loadEverything();
            }
            else{
                //now we have to make this hellish patchwork of callbacks for loading all the stuff we need
                //in the right order
                //I could probly just rename these and move them somewhere and this would be a lot more readable...

                //this is the basic one, we should always end with this
                function goBackToWaiting(){
                    MPD.responceProcessor = idleHandler;
                    sendString('idle\n');
                }

                //reload the statuses
                function reloadStatus(){
                    MPD.responceProcessor = getStateHandler(function(){
                        goBackToWaiting();
                    });
                    sendString('status\n');
                }

                //reload the queue, the status, then go back to waiting
                function reloadQueue(){
                    MPD.responceProcessor = getQueueHandler(
                        function(){
                            reloadStatus();
                        },
                        'QueueChanged'
                    );
                    sendString('playlistinfo\n');
                }

                //reloading all the stuff we need to reload
                function reloadStuff(){
                    if(actions.queue){
                        reloadQueue();
                    }
                    else if(actions.status){
                        reloadStatus();
                    }
                    else{
                        goBackToWaiting();
                    }
                }

                //maybe do this after reloading playlists
                if(actions.playlist){
                    loadAllPlaylists(reloadStuff);
                }
                else{
                    reloadStuff();
                }
            }
        }
        else{
            if(idleHandler.postIdle){
                MPD.responceProcessor = idleHandler.postIdle;
                delete idleHandler.postIdle;
            }
        }
    }


    /**
     * we are expecting a connection responce
     * @private
     */
    function handleConnectionMessage(lines){
        if(lines.length < 1){
            return;
        }
        var line = lines.shift(1);
        MPD.state.version = line.replace(/^OK MPD /, '');

        loadEverything();
    }


    /**
     * method name says it all
     * @private
     */
    function loadEverything(){
        //this loads all of the data from the MPD server we need
        //it gets the queue first, then the state (because the state references the queue), then all of the playlist data
        MPD.responceProcessor = getQueueHandler(function(){
            MPD.responceProcessor = getStateHandler(function(){
                loadAllPlaylists(function(){
                    loadAllTagValues(function(){
                        callHandler('DataLoaded',MPD.state);

                        //ok everything is loaded...
                        //just wait for something to change and deal with it
                        MPD.responceProcessor = idleHandler;
                        sendString('idle\n');
                    });
                });
            });
            sendString('status\n');
        }, 'QueueChanged');

        //request state info, start the initial data load cascade
        sendString('playlistinfo\n');
    }


    /**
     * reload all playlists
     * @private
     */
    function loadAllPlaylists(onDone){
        MPD.responceProcessor = getPlaylistsHandler(function(){
            //ok, because this wasn't complicated enough allready
            //we have to load the contents of each playlist, but we have to do it sequentially
            //but asynchronusly :)

            //load a list
            var list_idx = 0;
            (function loadList(){
                if(list_idx >= MPD.state.playlists.length){
                    onDone();
                }
                else{
                    MPD.responceProcessor = getPlaylistHandler(loadList, list_idx);
                    sendString('listplaylistinfo '+MPD.state.playlists[list_idx].playlist+'\n');
                    list_idx++;
                }
            })();
        });
        sendString('listplaylists\n');
    }


    /**
     * reload all valid tag values
     * @private
     */
    function loadAllTagValues(onDone){

        //get a list of tags we want possible values for
        var tags = [];
        for(tag in MPD.tag_values){
            if(MPD.tag_values[tag] !== null){
                tags.push(tag);
            }
        }
        var tag_idx = 0;

        //set the responce processor to add results to tags until we are done, then call on done
        MPD.responceProcessor = getlistHandler(function(list){
            MPD.tag_values[tags[tag_idx]] = list.map(function(obj){return obj[tags[tag_idx]]+'';});
            tag_idx++;
            if(tag_idx >= tags.length){
                onDone();
            }
            else{
                sendString('list '+tags[tag_idx]+'\n');
            }
        });
        sendString('list '+tags[tag_idx]+'\n');
    }


    /**
     * we are expecting a state responce
     * this is what we do when we get it
     * @private
     */
    function getStateHandler(onDone){
        return function(lines){
            var message_lines = getLines(lines, 'OK');
            message_lines.pop();//get rid of the 'OK' line
            if(message_lines.length > 0){
                var state = {};
                message_lines.forEach(function(line){
                    var key = line.replace(/([^:]+): (.*)/,'$1');
                    var value = line.replace(/([^:]+): (.*)/,'$2');
                    if(value.match(/^\d*(\.\d*)?$/)){
                        value = parseFloat(value);
                    }
                    state[key] = value;
                });
                //we have a state event!
                callHandler('StateChanged',state);
                onDone();
            }
        };
    }


    /**
     * handler for the current queue
     * @private
     */
    function getQueueHandler(onDone, event_type){
        return getlistHandler(onDone, event_type);
    }


    /**
     * handler for the list of playlists
     * @private
     */
    function getPlaylistsHandler(onDone){
        return getlistHandler(onDone, 'PlaylistsChanged');
    }


    /**
     * handler for the list of playlists
     * @private
     */
    function getSearchHandler(onDone){
        return getlistHandler(
            function(){
                onDone.apply(null, arguments);
                MPD.responceProcessor = idleHandler;
            }
        );
    }


    /**
     * handler for the list of directories (is exactly the same as the search handler :/ )
     * @private
     */
    function getDirectoryHandler(onDone){
        return getlistHandler(
            function(){
                onDone.apply(null, arguments);
                MPD.responceProcessor = idleHandler;
            }
        );
    }


    /**
     * handler for loading a single playlist
     * @private
     */
    function getPlaylistHandler(onDone, queue_idx){
        return getlistHandler(
            onDone,
            'PlaylistChanged',
            function(list){
                return {
                    idx: queue_idx,
                    songs: list
                };
            }
        );
    }


    /******************\
    |* public methods *|
    \******************/


    /**
     * get the current play time
     * @private
     */
    function getCurrentSongTime(){
        var current_song = getCurrentSong();
        if(!current_song){
            return 0;
        }

        var offset = 0;
        if(MPD.state.playstate === 'play'){
            var now = new Date();

            offset = (now.getTime() - MPD.last_status_update_time.getTime())/1000;
        }

        var last_time = MPD.state.current_song.elapsed_time;
        last_time = last_time?last_time:0;

        return Math.min(last_time + offset, current_song.time);
    }


    /**
     * get the song identified by it's position on the current queue, or null
     * @private
     */
    function getSongOnQueue(idx){
        var song = null;
        if(idx !== null && MPD.state.current_queue[idx]){
            song = MPD.state.current_queue[idx];
        }
        return cloneObject(song);
    }


    /**
     * get the current song, or null
     * @private
     */
    function getCurrentSong(){
        return getSongOnQueue(MPD.state.current_song.queue_idx);
    }


    /**
     * get the song next on the queue, or null
     * @private
     */
    function getNextSong(){
        return getSongOnQueue(MPD.state.next_song.queue_idx);
    }

    /**
     * make a deep copy of the passed object/array/primitive
     * @private
     */
    function cloneObject(obj){
        return JSON.parse(JSON.stringify(obj));
    }

    /**
     * params is a {tag<string> => value<string>} object, valid tags are enumerated in getTagTypes
     * onDone is a function that should be called on complete, will be passed an array of song objects
     * @private
     */
    function doSearch(params, onDone){
        var query = 'search';
        for(key in params){
            var value = params[key];
            query += ' '+key+' "'+value+'"';
        }
        idleHandler.postIdle = getSearchHandler(onDone);
        issueCommand(query);
    }


    /**
     * like above except for getting counts
     * @private
     */
    function doSearchCount(params, onDone){
        var query = 'count';
        for(key in params){
            var value = params[key];
            query += ' '+key+' "'+value+'"';
        }
        idleHandler.postIdle = getSearchHandler(function(results){
            onDone(results[0]);
        });
        issueCommand(query);
    }


    /**
     * returns a list of valid search tag types
     * @private
     */
    function getTagTypes(){
        return Object.keys(MPD.tag_values);
    }


    /**
     * Lists all songs and directories in path. also returns song file metadata info
     * path string -- the uri to the directory you are interested relative to the MPD media directory (blank string for root)
     * onDone function -- function called with all of the directory info at some point in the future
     * @private
     */
    function getDirectoryContents(path, onDone){
        idleHandler.postIdle = getDirectoryHandler(onDone);
        issueCommand('lsinfo "'+path+'"');
    }


    /********\
    |* INIT *|
    \********/
    init();
    //see I told you it was called down here

    /********************\
    |* public interface *|
    \********************/

    /**
     * event handler for 'Error' events
     * error event hander callback
     * @event Error
     * @type {Object}
     * @callback errorEventHandler
     * @param {Object} [responce_event] -
     */
    /**
     * generic event hander callback called when any sort of event happens
     * @event Event
     * @type {Object}
     * @callback eventHandler
     * @param {Object} [responce_event] - {type:String:data:Object} data depends onf type, see the other event handlers
     */
    /**
     * generic event hander callback called when any sort of event happens that doesn't have any handler set for it
     * @event Event
     * @type {Object}
     * @callback unhandledEventHandler
     * @param {Object} [responce_event] - {type:String:data:Object} data depends onf type, see the other event handlers
     */
    /**
     * event handler for 'DatabaseChanging' events
     * event hander callback for when the music database has started changing, there will be a DataLoaded event following this (unless something goes HORRIBLY wrong)
     * @event DatabaseChanging
     * @type {Object}
     * @callback databaseChangingEventHandler
     * @param {Object} [responce_event] -
     */
    /**
     * event handler for 'DataLoaded' events
     * called when a bulk dataload has completed and the mpd client's data is in a ocnsistent state. fired when a client has finished recovering from a reload which might be caused by a database change or (re)connecting
     * @event DataLoaded
     * @type {Object}
     * @callback dataLoadedEventHandler
     * @param {Object} [responce_event] -
     */
    /**
     * event handler for 'StateChanged' events
     * called when the state of the player has changed. This can be an scalar value. Things like currently playing song changing, volume, settings (consume, repeat, etc)
     * NOT called when the current play time changes, because that changes continuusly, you will need to poll that
     * @event StateChanged
     * @type {Object}
     * @callback stateChangedEventHandler|
     * @param {Object} [responce_event] - state object, the same as is returned by getState
     */
    /**
     * event handler for 'QueueChanged' events
     * something about the queue of playing songs changed
     * @event QueueChanged
     * @type {Object}
     * @callback queueChangedEventHandler|
     * @param {array} [songs] - [{song}] array of songs on the queue
     */
    /**
     * event handler for 'PlaylistsChanged' events
     * some playlist somewhere changed.
     * @event PlaylistsChanged
     * @type {Object}
     * @callback playlistsChangedEventHandler
     * @param {array} [playlists] - [string] array of names of all playlists. note: there doesn't seem to be a way to get just the changed ones, so you get the list of everything, you can tell if something was added or removed but you have no way of telling if any particular playlist has been changed. this is a limitation of MPD
     */
    /**
     * event handler for 'Connect' events
     * the client has connected, but no data has yet loaded
     * you can use this to setup event handlers, or just do that before connecting
     * @event Connect
     * @type {Object}
     * @callback connectEventHandler
     */
    /**
     * event handler for 'Disconnect' events
     * the client has disconnected
     * @event Disconnect
     * @type {Object}
     * @callback disconnectEventHandler
     */

    return {
        /**
         * adds an event handler
         * @function on
         * @throws {Exception} if you try to listen to an invalid event type
         * @param {String} event_name - what sort of event to listen for. must be one of the following:  'Error', 'Event', 'UnhandledEvent', 'DatabaseChanging', 'DataLoaded', 'StateChanged', 'QueueChanged', 'PlaylistsChanged', 'PlaylistChanged','Connect', 'Disconnect'
         * @param {disconnectEventHandler|connectEventHandler|playlistsChangedEventHandler|queueChangedEventHandler|stateChangedEventHandler|dataLoadedEventHandler|databaseChangingEventHandler|unhandledEventHandler|eventHandler|errorEventHandler} handler - function called when the given event happens
         */
        on: on,

        /**
         * returns an object representation of the current state of MPD as the client understands it right now
         * @function
         * @returns {state}
         */
        getState: function(){
            return cloneObject(MPD.state);
        },

        /**
         * call to turn off logging to the console
         * @function
         */
        disableLogging: function(){
            MPD.do_logging = false;
        },

        /**
         * call to turn logging to the console on (debugging)
         * @function
         */
        enableLogging: function(){
            MPD.do_logging = true;
        },

        /**
         * return the port number this client was instansiated with and thet it is (attempting to) connect with
         * @function
         * @returns {int}
         */
        getPort: function(){
            return _port;
        },

        /**
         * gets the protocol versing reported on connection
         * @function
         * @returns {String}
         */
        getProtocolVersion: function(){
            return MPD.state.version;
        },

        /**
         * retruns if we are connected or not
         * @function
         * @returns {bool} true if we are connected, false if we are not
         */
        isConnected: function(){
            return MPD.state.connected == true;
        },

        /**
         * Returns a string enum describing the playback state
         * @function
         * @returns {String} - 'play', 'pause', 'stop'
         */
        getPlaystate: function(){
            return MPD.state.playstate;
        },

        /**
         * returns the current volume
         * @function
         * @returns {float} between 0 and 1
         */
        getVolume: function(){
            return MPD.state.volume;
        },

        /**
         * returns if we are in repeat mode or not
         * @function
         * @returns {boolean} true if we are in repeat mode, false otherwise
         */
        isRepeat: function(){
            return MPD.state.repeat == true;
        },

        /**
         * returns if we are in single mode or not
         * @function
         * @returns {boolean} true if we are in single mode, false otherwise
         */
        isSingle: function(){
            return MPD.state.single == true;
        },

        /**
         * returns if we are in consume mode or not
         * @function
         * @returns {boolean} true if we are in consume mode, false otherwise
         */
        isConsume: function(){
            return MPD.state.consume == true;
        },

        /**
         * returns if we are in random playback mode or not
         * @function
         * @returns {boolean} true if we are in random mode, false otherwise
         */
        isRandom: function(){
            return MPD.state.random == true;
        },

        /**
         * honestly don't know what this is, has something to do with some sort of fading mode I never use, but MPD reports it so I'm making an accessor for it in case someone else wants to use it
         * @function
         * @returns {float}
         */
        getMixRampThreashold: function(){
            return MPD.state.mix_ramp_threshold;
        },


        /**
         * gets the currently playing song
         * @function getCurrentSong
         * @returns {song}
         */
        getCurrentSong:getCurrentSong,

        /**
         * gets the time of the current song. will calculate it based on the reported time, and how long it's been since that happened
         * @function getCurrentSongTime
         * @returns {float}
         */
        getCurrentSongTime:getCurrentSongTime,

        /**
         * get's the queue id of the currently playing song
         * @function
         * @returns {int}
         */
        getCurrentSongID: function(){
            return MPD.state.current_song.id;
        },

        /**
         *gets the position on the queue of the song currently playing
         * @function
         * @returns {int}
         */
        getCurrentSongQueueIndex: function(){
            return MPD.state.current_song.queue_idx;
        },


        /**
         * gets the song next to be played
         * @function getNextSong
         * @returns {song}
         */
        getNextSong:getNextSong,

        /**
         * gets the queue id of the next song to play
         * @function
         * @returns {int}
         */
        getNextSongID: function(){
            return MPD.state.next_song.id;
        },

        /**
         * returns the position on the queue of the next song on the queue to play
         * @function
         * @returns {int}
         */
        getNextSongQueueIndex: function(){
            return MPD.state.next_song.queue_idx;
        },


        /**
         * get the whole queue
         * @function
         * @returns {queue_song[]}
         */
        getQueue: function(){
            return cloneObject(MPD.state.current_queue);
        },

        /**
         * returns the version of the queue, this number changes every time the queue does
         * @function
         * @returns {int}
         */
        getQueueVersion: function(){
            return MPD.state.queue_version;
        },


        /**
         * returns an array of strings that is the list of saved playlists
         * @function
         * @returns {String[]}
         */
        getPlaylists: function(){
            return cloneObject(MPD.state.playlists);
        },

        /**
         * given the name of a playlist retrun the playlist or null if no playlist with that name exsists
         * @function
         * @param {String} name - the name of the playlist you want a copy of
         * @returns {song[]|null}
         */
        getPlaylistByName: function(name){
            var ret = null;
            MPD.state.playlists.forEach(function(p){
                if(p.playlist==name){
                    ret = p;
                }
            });
            return ret;
        },

        /**
         * turns on consume mode
         * @function
         */
        enablePlayConsume: function(){
            issueCommand('consume 1');
        },

        /**
         * turns off consume mode
         * @function
         */
        disablePlayConsume: function(){
            issueCommand('consume 0');
        },

        /**
         * turns on crossfade
         * @function
         */
        enableCrossfade: function(){
            issueCommand('crossfade 1');
        },

        /**
         * turns off crossfade
         * @function
         */
        disableCrossfade: function(){
            issueCommand('crossfade 0');
        },

        /**
         * turns on random play mode
         * @function
         */
        enableRandomPlay: function(){
            issueCommand('random 1');
        },

        /**
         * turns off random play mode
         * @function
         */
        disableRandomPlay: function(){
            issueCommand('random 0');
        },

        /**
         * turns on repeat play mode
         * @function
         */
        enableRepeatPlay: function(){
            issueCommand('repeat 1');
        },

        /**
         * turns of repeat play mode
         * @function
         */
        disableRepeatPlay: function(){
            issueCommand('repeat 0');
        },

        /**
         * turns on single play mode
         * @function
         */
        enableSinglePlay: function(){
            issueCommand('single 1');
        },

        /**
         * turns of single play mode
         * @function
         */
        disableSinglePlay: function(){
            issueCommand('single 0');
        },

        /**
         * Sets the threshold at which songs will be overlapped. Like crossfading but doesn't fade the track volume, just overlaps. The songs need to have MixRamp tags added by an external tool. 0dB is the normalized maximum volume so use negative values, I prefer -17dB. In the absence of mixramp tags crossfading will be used. See http:     // sourceforge.net/projects/mixramp
         * @function
         * @param {float} decibels
         */
        setMixRampDb: function(decibels){
            issueCommand('mixrampdb '+decibels);
        },

        /**
         * Additional time subtracted from the overlap calculated by mixrampdb. A value of "nan" disables MixRamp overlapping and falls back to crossfading.
         * @function
         * @param {float|string} seconds - time in seconds or "nan" to disable
         */
        setMixRampDelay: function(seconds){
            issueCommand('mixrampdelay '+seconds);
        },

        /**
         * Sets volume, the range of volume is 0-1.
         * @function
         * @param {float} volume - 0-1
         */
        setVolume: function(volume){
            volume = Math.min(1,volume);
            volume = Math.max(0,volume);
            issueCommand('setvol '+volume*100);
        },

        /**
         * Begins playing if not playing already. optional parameter starts playing a particular song
         * @function
         * @param {int} [queue_position=<current song>] - the song to start playing
         */
        play: function(queue_position){
            if(typeof queue_position != 'undefined'){
                issueCommand('play '+queue_position);
            }
            else{
                issueCommand('play');
            }
        },

        /**
         * Begins playing the playlist at song identified by the passed song_id.
         * @function
         * @param {int} song_id - the queue id of the song you want to start playing
         */
        playById: function(song_id){
            issueCommand('playid '+song_id);
        },

        /**
         * pauses/resumes playing
         * @function
         * @param {boolean} [do_pause=true] - true if you want to pause, false if you want to be unpaused
         */
        pause: function(do_pause){
            if(typeof do_pause == 'undefined' || do_pause){
                issueCommand('pause 1');
            }
            else{
                issueCommand('pause 0');
            }
        },

        /**
         * Plays next song in the queue.
         * @function
         */
        next: function(){
            issueCommand('next');
        },

        /**
         * Plays previous song in the queue.
         * @function
         */
        previous: function(){
            issueCommand('previous');
        },

        /**
         * Seeks to the position time (in seconds) within the current song. If prefixed by '+' or '-', then the time is relative to the current playing position.
         * @function
         * @param {float|string} - what point in the current song to seek to or string with a signed float in it for relative seeking. i.e. "+0.1" to seek 0.1 seconds into the future, "-0.1" to seek 0.1 seconds into the past
         */
        seek: function(time){
            issueCommand('seekid '+MPD.state.current_song.id+' '+time);
        },

        /**
         * Stops playing.
         * @function
         */
        stop: function(){
            issueCommand('stop');
        },

        /**
         * Adds the file to the playlist (directories add recursively).
         * @function
         * @param {String} pathname - of a single file or directory. relative to MPD's mussic root directory
         */
        addSongToQueueByFile: function(filename){
            issueCommand('add "'+filename+'"');
        },

        /**
         * Clears the current queue
         * @function
         */
        clearQueue: function(){
            issueCommand('clear');
        },

        /**
         * Deletes a song from the queue
         * @function
         * @param {int} position - index into the queue to the song you don't want to be on the queue any more
         */
        removeSongFromQueueByPosition: function(position){
            issueCommand('delete '+position);
        },

        /**
         * Deletes a range of songs from the playlist.
         * @function
         * @param {int} start - the queue index of the first song on the playlist you want to remove
         * @param {int} end - the queue index of the last song on the playlist you want to remove
         */
        removeSongsFromQueueByRange: function(start, end){
            issueCommand('delete '+start+' '+end);
        },

        /**
         * Deletes the song identified with the passed queue id from the playlist
         * @function
         * @param {int} id - the queue id of the song you want to remove from the queue
         */
        removeSongsFromQueueById: function(id){
            issueCommand('deleteid '+id);
        },

        /**
         * a song from one position on the queue to a different position
         * @function
         * @param {int} position - the position of the song to move
         * @param {int} to - where you want the sang to go
         */
        moveSongOnQueueByPosition: function(position, to){
            issueCommand('move '+position+' '+to);
        },

        /**
         * moves a range of songs on the queue
         * @function
         * @param {int} start - the queue index of the first song on the queue you want to move
         * @param {int} end - the queue index of the last song on the queue you want to move
         * @param {int} to - the queue index were the first song should end up
         */
        moveSongsOnQueueByPosition: function(start, end, to){
            issueCommand('move '+start+':'+end+' '+to);
        },

        /**
         * moves the song identified with the passed queue id to the passed queue index
         * @function
         * @param {int} id - queue id of the song you want to move
         * @param {int} to - the queue indes you want it to be
         */
        moveSongOnQueueById: function(id, to){
            issueCommand('moveid '+id+' '+to);
        },

        /**
         * Shuffles the current playlist.
         * @function
         */
        shuffleQueue: function(){
            issueCommand('shuffle');
        },

        /**
         * Swaps the positions of two songs identified by their queue indexes
         * @function
         * @param {int} pos1 - queue index of the first song
         * @param {int} pos2 - queue index of the second song
         */
        swapSongsOnQueueByPosition: function(pos1, pos2){
            issueCommand('swap '+pos1+' '+pos2);
        },

        /**
         * Swaps the positions of two songs identified by their queue ids
         * @function
         * @param {int} id1 - queue id of the first song
         * @param {int} id2 - queue id of the second song
         */
        swapSongsOnQueueById: function(id1, id2){
            issueCommand('swapid '+id1+' '+id2);
        },

        /**
         * Loads the given playlist to the end of the current queue.
         * @function
         * @param {String} playlist_name - the name of the playlist you want to append to the queue
         */
        appendPlaylistToQueue: function(playlist_name){
            issueCommand('load "'+playlist_name+'"');
        },

        /**
         * Loads the given playlist into the current queue replacing it.
         * @function
         * @param {String} playlist_name - the name of the playlist you want to append to the queue
         */
        loadPlaylistIntoQueue: function(playlist_name){
            issueCommand('clear');
            issueCommand('load "'+playlist_name+'"');
        },

        /**
         * Saves the current queue as a the given playlist, overwrites exsisting playlist of that name if it exsists, otherwise makes a new one
         * @function
         * @param {String} playlist_name - the name of the playlist you want to use as your new queue
         */
        saveQueueToPlaylist: function(playlist_name){
            issueCommand('save "'+playlist_name+'"');
        },

        /**
         * adds the given song (filename) to the given playlist
         * @function
         * @param {String} playlist_name - the playlist to add the song to
         * @param {String} filename - the filename of the song you want to add
         */
        addSongToPlaylistByFilename: function(playlist_name, filename){
            issueCommand('playlistadd "'+playlist_name+'" "'+filename+'"');
        },

        /**
         * Clears the playlist leaving it still in exsistance, but empty
         * @function
         * @param {String} playlist_name - the poor unfortunate playlist you want to hollow out
         */
        clearPlaylist: function(playlist_name){
            issueCommand('playlistclear "'+playlist_name+'"');
        },

        /**
         * Deletes the song at the given position from the given playlist
         * @function
         * @param {String} playlist_name - the name of the playlist with a song on it that you think shouldn't be there anymore
         * @param {int} position - the position in the playlist of the song you want to remove
         */
        removeSongFromPlaylist: function(playlist_name, position){
            issueCommand('playlistdelete "'+playlist_name+'" '+position);
        },

        /**
         * Moves SONGID in the playlist NAME.m3u to the position SONGPOS.
         * I'll be honest, I'm not sure what this does, I'm wrapping a command
         * documented int the MPD protocol and this is the only time ids are
         * referenced in regaurds to playlists and they are not in the songs
         * returned by the various playlist listing commands, so I'm guessing
         * id is a queue id, even though that doesn't make much sense.
         * @function
         * @param {String} playlist_name
         * @param {int} id
         * @param {int} position
         */
        moveSongOnPlaylistById: function(playlist_name, id, position){
            issueCommand('playlistmove "'+playlist_name+'" '+id+' '+position);
        },

        /**
         * Renames the playlist
         * @function
         * @param {String} playlist_name - the name is it right now
         * @param {String} new_name - the name it should be
         */
        renamePlaylist: function(playlist_name, new_name){
            issueCommand('rename "'+playlist_name+'" "'+new_name+'"');
        },

        /**
         * this kills the playlist
         * @function
         * @param {String} playlist_name - the name of the playlist you want to obliterate and never see any trace of again
         */
        deletePlaylist: function(playlist_name){
            issueCommand('rm "'+playlist_name+'"');
        },

        /**
         * Updates the music database: find new files, remove deleted files, update modified files.
         * @function
         */
        updateDatabase: function(){
            issueCommand('update');
        },

        /**
         * Lists all songs and directories in path (blank string for root). also returns song file metadata info
         * @callback directoryContentsCallback
         * @param {directory[]} [directory_contents] - the contents of the directory, will be an array of objects representing director(y|ies) and/or song(s) interleived
         *
         * @function getDirectoryContents
         * @param {String} [path] - path to the directory you are interested in relative to MPD's music root directory (root is a blank string, never start with '/')
         * @param {directoryContentsCallback}
         */
        getDirectoryContents:getDirectoryContents,

        /**
         * return an array of strings which are all of the valid tags
         * @function getTagTypes
         * @returns {String[]}
         */
        getTagTypes: getTagTypes,

        /**
         * return an array of strings which are all of the values the passed tag is allowed to have, or null if the tag is unconstrained
         * @function
         * @param {String} tag - the tag you want to know the possible values for
         * @returns {String[]|null}
         */
        getTagOptions: function(tag){
            return MPD.tag_values[tag]?MPD.tag_values[tag]:null;
        },

        /**
         * is given search results when the search is complete
         * @callback searchResultsCallback
         * @param {song[]} search_results - all of the songs that match the tag values you asked for
         *
         * params is a {tag<string> => value<string>} object, valid tags are enumerated in getTagTypes, onDone is a function that should be called on complete, will be passed an array of song objects
         * @function search
         * @param {Object} params - object that maps a tag type to a tag value that you want to find matches for {tag<string> => value<string>}
         * @param {searchResultsCallback} onDone - function called when the search results have come back, is passed the results as it's only parameter
         */
        search: doSearch,

        /**
         * is passed the number of songs matching the given search criteria
         * @callback searchCountCallback
         * @param {int} search_result_count - number of songs matched by the tag values
         *
         * like search except just for finding how many results you'll get (for faster live updates while criteria are edited)
         * params is a {tag<string> => value<string>} object, valid tags are enumerated in getTagTypes, onDone is a function that should be called on complete, will be passed the numver of results the search would produce
         * @function searchCount
         * @param {Object} params - object that maps a tag type to a tag value that you want to find matches for {tag<string> => value<string>}
         * @param {searchCountCallback} onDone - function called when the search results have come back, is passed the results as it's only parameter
         */
        searchCount: doSearchCount
    };
};
